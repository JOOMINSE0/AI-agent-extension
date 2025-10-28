// src/extension.ts
import * as vscode from "vscode";
import * as fs from "fs";     // [NEW] 동적 CVE DB 로딩용
import * as path from "path"; // [NEW] 동적 CVE DB 로딩용

/**
 * AI Approval Agent (CRAI 식 적용 + 정적 분석 기반 SF/SR/SD 산출)
 *
 * 교수님 요구사항 반영 핵심:
 *  - [중요] CVE.org JSON에서 생성된 벡터(DB)를 동적으로 로딩하여
 *    "가짜/임의"가 아닌 "실제 데이터 기반" 유사도 계산으로 CRAI를 산출.
 *  - [변경] 고정 vocab(CVE_VOCAB) 삭제. 사전투영 없이 공통키(합집합) 기반 코사인.
 *  - [Fallback] generated_cve_db.json이 없을 경우, 최소 구동을 위한 내장 시그니처 유지.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0) 확장 활성화
// ─────────────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  console.log("AI Approval Agent is now active!");

  // [NEW] 확장 시작 시 CVE 벡터 DB 로드 (동적 → 없으면 Fallback)
  DYN_CVE_DB = loadGeneratedCveDb(context);
  if (DYN_CVE_DB.length) {
    console.log(`[CVE] Loaded generated DB: ${DYN_CVE_DB.length} signature(s)`);
  } else {
    console.warn("[CVE] generated_cve_db.json not found. Using built-in fallback DB.");
  }

  const provider = new ApprovalViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("aiApprovalView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ai-approval-agent.showPanel", () => {
      vscode.window.showInformationMessage("AI Approval Panel opened!");
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Webview Provider
// ─────────────────────────────────────────────────────────────────────────────

class ApprovalViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "src", "webview")]
    };
    const nonce = getNonce();
    view.webview.html = getHtml(view.webview, this.ctx, nonce);
    wireMessages(view.webview);
  }
}

/* ---------- Config ---------- */
function getCfg() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    // 코드 생성(스트리밍)용 Ollama (점수 계산엔 사용 안 함)
    endpoint: (cfg.get<string>("aiApproval.ollama.endpoint") || "http://210.110.103.64:11434").replace(/\/$/, ""),
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3.1:8b",
    // 최상위 FRD 가중치 (합 1 권장)
    wF: cfg.get<number>("aiApproval.weights.functionality") ?? 0.40,
    wR: cfg.get<number>("aiApproval.weights.resource") ?? 0.30,
    wD: cfg.get<number>("aiApproval.weights.dependency") ?? 0.30
  };
}

/* ---------- Webview messaging ---------- */
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "approve": {
          const { code = "", language = "plaintext", filename = null, score = null, severity = null } = msg || {};
          // RED 게이트: 확인문자 요구
          if (severity === "red") {
            const input = await vscode.window.showInputBox({
              prompt: `High risk (${score}). Type 'CONFIRM' to continue.`,
              validateInput: v => (v === "CONFIRM" ? null : "You must type CONFIRM to proceed.")
            });
            if (input !== "CONFIRM") return;
          }
          await handleApproval(code, language, filename);
          break;
        }

        case "reject": {
          vscode.window.showWarningMessage("Rejected (not saved or executed).");
          break;
        }

        case "details": {
          vscode.window.showInformationMessage("View details: the reason is shown on the card.");
          break;
        }

        case "ask": {
          const { endpoint, model, wF, wR, wD } = getCfg();
          try {
            // 1) (옵션) 코드 생성 스트리밍 — 점수와 무관, UI 제공용
            const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
              webview.postMessage({ type: "delta", text: delta });
            });

            // 2) 코드블록 추출 + 파일명 힌트
            const snippet = extractLastCodeBlockTS(fullText);
            const code = snippet?.code ?? "";
            const language = snippet?.language ?? "plaintext";
            const suggested = detectSuggestedFileName(fullText, language);

            // 3) 정적 파이프라인 실행 → StaticMetrics
            const metrics = await runStaticPipeline(code, suggested, language);

            // 4) 정적 분석 결과 → 신호(F/R/D) → 차원 점수
            const heur = analyzeFromStaticMetrics(metrics, suggested);

            // 5) 최종 CRAI (식 2) 계산 — 0.0~10.0 스케일
            const fusedVector = heur.vector;
            const scored = scoreFromVector(fusedVector, { wF, wR, wD });

            // 6) 웹뷰로 전달 (증거 포함)
            webview.postMessage({
              type: "analysis",
              vector: fusedVector,
              score: scored.score,
              severity: scored.severity,
              level: scored.level,
              weights: scored.weights,
              suggestedFilename: suggested || null,
              language,
              code,
              reasons: heur.reasons,
              crai_components: scored.crai_components,
              signalTable: heur.signalTable,
              breakdown: {
                heurOnly: { vector: heur.vector, ...scored }
              }
            });

            webview.postMessage({ type: "done" });
          } catch (e: any) {
            const detail = e?.message || String(e);
            console.error("분석 파이프라인 실패:", e);
            vscode.window.showErrorMessage(`분석 실패: ${detail}`);
            webview.postMessage({ type: "error", message: detail });
          }
          break;
        }
      }
    } catch (e: any) {
      const detail = e?.message || String(e);
      console.error(detail);
      vscode.window.showErrorMessage(detail);
      webview.postMessage({ type: "error", message: detail });
    }
  });
}

/* ---------- Ollama chat (stream + return full text) ---------- */
async function chatWithOllamaAndReturn(
  endpoint: string,
  model: string,
  userText: string,
  onDelta: (text: string) => void
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) return ""; // 네트워크 불가 환경에서도 UI가 깨지지 않도록

  const res = await fetchFn(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: "You are a helpful coding assistant inside VS Code." },
        { role: "user", content: userText }
      ]
    })
  });

  if (!res.ok || !res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let full = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const piece = obj?.message?.content || "";
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* ignore partial */
      }
    }
  }
  return full;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) CVE 벡터 DB 및 유사도 계산
// ─────────────────────────────────────────────────────────────────────────────

/** CVE 벡터 시그니처 타입 (동적/내장 공용) */
type CveVectorSig = {
  id: string;
  title: string;
  tokens: Record<string, number>; // 중요 토큰과 가중치
  baseSeverity: number;           // 0..1
  notes?: string;
};

/** [NEW] 동적으로 로드된 벡터 DB (generated_cve_db.json) */
let DYN_CVE_DB: CveVectorSig[] = [];

/** [NEW] generated_cve_db.json 로드 함수 */
function loadGeneratedCveDb(ctx?: vscode.ExtensionContext): CveVectorSig[] {
  try {
    const base = ctx ? ctx.extensionUri.fsPath : process.cwd();
    const p = path.join(base, "cve_data", "generated_cve_db.json"); // scripts/build_cve_vocab.ts 출력 경로
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw) as CveVectorSig[];
    // sanity check
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error("[CVE] loadGeneratedCveDb error:", e);
    return [];
  }
}

/** [KEEP] 내장 Fallback DB (최소 동작 보장). 실제 분석은 DYN_CVE_DB 우선. */
const FALLBACK_CVE_VECTOR_DB: CveVectorSig[] = [
  {
    id: "SIG-CMD-INJECT",
    title: "Command Injection via shell/exec",
    baseSeverity: 0.95,
    tokens: { exec: 1.5, spawn: 1.3, shell: 1.2, system: 1.4, popen: 1.4, "child_process": 1.6, bash: 1.0, sh: 1.0, userinput: 0.8, "stringConcat": 0.8 }
  },
  {
    id: "SIG-SQLI-CONCAT",
    title: "SQL Injection via string concatenation",
    baseSeverity: 0.90,
    tokens: { select: 1.2, insert: 1.2, update: 1.2, delete: 1.2, where: 1.0, from: 0.8, concat: 1.2, format: 0.8, fstring: 0.8, userinput: 0.8, query: 1.0 }
  },
  {
    id: "SIG-DESERIALIZE-RCE",
    title: "Unsafe Deserialization",
    baseSeverity: 0.85,
    tokens: { deserialize: 1.4, "pickle.loads": 1.6, "yaml.unsafe": 1.6, ObjectInputStream: 1.4, eval: 0.7 }
  },
  {
    id: "SIG-SSTI",
    title: "Server-Side Template Injection",
    baseSeverity: 0.80,
    tokens: { template: 1.2, render: 1.0, ejs: 1.2, jinja: 1.2, mustache: 1.0, eval: 0.8, Function: 0.8, userinput: 0.8 }
  },
  {
    id: "SIG-REGEX-DOS",
    title: "Catastrophic backtracking (ReDoS)",
    baseSeverity: 0.70,
    tokens: { regex: 1.0, "re.compile": 1.0, catastrophic: 1.2, userinput: 0.6 }
  },
  {
    id: "SIG-VULN-PKG",
    title: "Known vulnerable package used",
    baseSeverity: 0.90,
    tokens: { vulnerable_pkg_2023: 2.0 }
  }
];

/** [NEW] 실제로 사용할 DB 선택 (동적 우선, 없으면 Fallback) */
function getSigDB(): CveVectorSig[] {
  return (DYN_CVE_DB && DYN_CVE_DB.length) ? DYN_CVE_DB : FALLBACK_CVE_VECTOR_DB;
}

/** 코드 문자열 → 토큰 벡터(가중치 포함)
 *  (NOTE) 이 부분은 예전과 동일. 코드에서 의미 토큰을 추출한다.
 */
function vectorizeCodeToTokens(code: string): Record<string, number> {
  const lower = code.toLowerCase();

  const features: Record<string, number> = {};
  const add = (k: string, w = 1) => (features[k] = (features[k] ?? 0) + w);

  // 일반 토큰
  const words = lower.match(/[a-z_][a-z0-9_.]+/g) || [];
  const wordSet = new Set(words);

  // 입력/문자열 결합 힌트
  if (/\b(input|prompt|readline|process\.argv|req\.query|req\.body|request\.getparameter)\b/.test(lower)) add("userinput", 1);
  if (/("|'|`)\s*\+\s*\w|\w\s*\+\s*("|'|`)/.test(code)) add("stringConcat", 1);

  // SQL
  ["select","insert","update","delete","where","from","union","concat"].forEach(k => { if (wordSet.has(k)) add(k, 1); });
  if (/\bfstring\b|`.*\${.*}`/.test(lower)) add("fstring", 1);
  if (/\.format\(/.test(lower)) add("format", 1);
  if (/\bquery\b/.test(lower)) add("query", 1);

  // 명령 실행/셸
  if (/\b(exec|spawn)\b/.test(lower)) add("exec", 1), add("spawn", 0.5);
  if (/\b(child_process)\b/.test(lower)) add("child_process", 1.2);
  if (/\bsystem\(|popen\(|subprocess\.(popen|run|call)\b/.test(lower)) { add("system", 1); add("popen", 1); add("subprocess", 0.5); }
  if (/\b(sh|bash)\b/.test(lower)) add("sh", 0.3), add("bash", 0.3);

  // 파일/환경
  if (/\bfs\.(read|write|unlink|chmod|chown|readdir)/.test(lower)) add("fs.read", 0.8), add("fs.write", 0.6);
  if (/\bprocess\.env\b|secret|password|credential/.test(lower)) add("env", 1), add("password", 0.6), add("credential", 0.6);

  // 템플릿/SSTI
  if (/\brender\(|template|ejs|jinja|mustache/.test(lower)) add("render", 0.8), add("template", 0.6);
  if (/\beval\(|new\s+Function\(/.test(lower)) add("eval", 1), add("Function", 0.5);

  // 역직렬화
  if (/pickle\.loads|yaml\.load\(|yaml\.unsafe_load|objectinputstream/.test(lower)) add("deserialize", 1.2), add("pickle.loads", 1.6), add("yaml.unsafe", 1.4);

  // 정규표현식
  if (/(new\s+RegExp|re\.compile|\bre\b)/.test(lower)) add("regex", 1), add("re.compile", 0.6);
  if (/(a+)+|(\.\*)\1/.test(lower)) add("catastrophic", 0.8);

  // 네트워크
  if (/\b(fetch|axios|request|http\.|https\.)/.test(lower)) add("fetch", 0.8), add("axios", 0.6), add("request", 0.6), add("http", 0.6), add("https", 0.6);

  // 취약 패키지(예시)
  if (/vulnerable[_-]?pkg[_-]?2023/.test(lower)) add("vulnerable_pkg_2023", 2);

  return features;
}

/** 코사인 유사도 (공통키 합집합 기반)
 *  (NOTE) 예전엔 고정 vocab으로 투영 후 비교 → 삭제.
 *  객체 키의 합집합을 돌며 내적/노름을 계산하므로 자동 정렬된다.
 */
function cosineSim(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = a[k] ?? 0;
    const vb = b[k] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 코드 벡터 vs (동적/내장) 시그니처 DB 유사도 계산 → severity 0..1, 상위 매치 리턴 */
function vectorCveScan(code: string) {
  const codeVec = vectorizeCodeToTokens(code);
  const DB = getSigDB();

  const results = DB.map(sig => {
    // [중요] 투영 없이 그대로 비교 (키 합집합 기반 코사인)
    const sim = cosineSim(codeVec, sig.tokens);
    // 유사도 기반 가중 severity: sig.baseSeverity * smooth(sim)
    const sev = sig.baseSeverity * Math.min(1, Math.pow(Math.max(0, sim), 0.8) * 1.2);
    return { id: sig.id, title: sig.title, similarity: sim, severity01: sev, notes: sig.notes ?? "" };
  }).sort((a,b)=>b.severity01-a.severity01);

  // 집계: top-k(3) 결합 1-Π(1-sev_i)
  const topK = results.slice(0, 3);
  let agg = 0;
  for (const r of topK) agg = 1 - (1 - agg) * (1 - r.severity01);

  return { aggregatedSeverity01: Math.min(1, agg), matches: results.filter(r=>r.similarity>0.15).slice(0,5) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 정밀 리소스/보안 + CRAI 계산 (기존 로직 유지)
// ─────────────────────────────────────────────────────────────────────────────

type BigOClass = "O(1)"|"O(log n)"|"O(n)"|"O(n log n)"|"O(n^2)"|"O(n^3)"|"unknown";
type StaticMetrics = {
  // SF
  apiChanges: number;
  totalApis: number;
  coreTouched: boolean;
  diffChangedLines: number;
  totalLines: number;
  schemaChanged: boolean;

  // SR (정밀)
  bigO: BigOClass;
  cc: number;
  loopCount: number;
  loopDepthApprox: number;
  recursion: boolean;
  divideAndConquerHint: boolean;
  sortHint: boolean;
  regexDosHint: boolean;

  memAllocs: number;
  memBytesApprox: number;
  externalCalls: number;
  ioCalls: number;

  // SD
  cveSeverity01: number;
  libReputation01: number;
  licenseMismatch: boolean;
  permRisk01: number;

  _reasons: string[];
};

const clamp01 = (x:number)=> Math.max(0, Math.min(1, x));
function mapBigOTo01(bigO: BigOClass){
  const lut:{[k in BigOClass]:number} = {
    "O(1)":0.05, "O(log n)":0.15, "O(n)":0.20, "O(n log n)":0.35, "O(n^2)":0.70, "O(n^3)":0.90, "unknown":0.50
  };
  return lut[bigO] ?? 0.50;
}
const sat01 = (x:number, k:number)=> clamp01(1 - Math.exp(-k * Math.max(0,x))); // 포화형 스케일러

function preciseResourceAndSecurityScan(code: string): Omit<StaticMetrics,
  "apiChanges"|"totalApis"|"coreTouched"|"diffChangedLines"|"totalLines"|"schemaChanged"> {

  const reasons: string[] = [];
  const lower = code.toLowerCase();

  // Cyclomatic Complexity (간이)
  const branches = (code.match(/\b(if|else if|case|catch|&&|\|\||\?[:]|for|while|switch|try)\b/g) || []).length;
  const cc = 1 + branches;

  // 루프 및 중첩 근사
  const loopCount = (code.match(/\b(for|while|forEach|map\(|reduce\()/g) || []).length;
  const nestedLoop = /\b(for|while)\s*\([^)]*\)\s*{[^{}]*\b(for|while)\s*\(/s.test(code);
  const tripleNested = /\b(for|while)[\s\S]{0,300}\b(for|while)[\s\S]{0,300}\b(for|while)/s.test(code);
  const loopDepthApprox = tripleNested ? 3 : nestedLoop ? 2 : loopCount > 0 ? 1 : 0;

  // 정렬/분할정복/재귀 힌트
  const sortHint = /\b(sort\(|Collections\.sort|Arrays\.sort)\b/.test(code);
  const recursion = /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*{[\s\S]*?\b\1\s*\(/.test(code) ||
                    /([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*=>[\s\S]*?\b\1\s*\(/.test(code);
  const divideAndConquerHint = recursion && /\b(mid|merge|partition|divide|conquer)\b/i.test(code);

  // 정규표현식 폭발 가능성
  const regexDosHint = /(a+)+|(\.\*){2,}|(.*){2,}/.test(code) && /(re\.compile|new\s+RegExp)/.test(code);

  // 외부 호출/IO
  const externalCalls = (code.match(/\b(fetch|axios|request|http\.|https\.|jdbc|mongo|redis|sequelize|prisma)\b/gi) || []).length;
  const ioCalls = (code.match(/\bfs\.(read|write|append|unlink|readdir|chmod|chown)|open\(|readFileSync|writeFileSync\b/gi) || []).length;

  // 메모리 바이트 근사
  let memBytesApprox = 0;
  const inc = (n: number)=> { memBytesApprox += Math.max(0, n); };

  // Buffer.alloc(N)
  const bufAlloc = [...code.matchAll(/Buffer\.alloc\s*\(\s*(\d+)\s*\)/gi)];
  bufAlloc.forEach(m => inc(parseInt(m[1],10)));

  // new Array(N) / Array(N).fill(K)
  const arrAlloc = [...code.matchAll(/\bnew\s+Array\s*\(\s*(\d+)\s*\)|\bArray\s*\(\s*(\d+)\s*\)\.fill/gi)];
  arrAlloc.forEach(m => inc(((parseInt(m[1] || m[2],10) || 0) * 8)));

  // 문자열/객체/배열 리터럴 크기 근사
  const strLits = [...code.matchAll(/(["'`])([^"'`\\]|\\.){1,200}\1/g)];
  strLits.forEach(m => inc((m[0]?.length || 0)));
  const arrayLits = [...code.matchAll(/\[([^\[\]]{0,400})\]/g)];
  arrayLits.forEach(m => { const elems = (m[1].split(",").length) || 0; inc(elems * 16); });
  const objectLits = [...code.matchAll(/\{([^{}]{0,400})\}/g)];
  objectLits.forEach(m => { const props = (m[1].match(/:/g) || []).length; inc(props * 24); });

  // 컬렉션(Map/Set)
  const mapSet = (code.match(/\bnew\s+(Map|Set)\s*\(/g) || []).length;
  inc(mapSet * 128);

  // 명령 실행/권한 위험
  let permRisk = 0;
  if (/\b(child_process|exec\(|spawn\(|system\(|popen\(|subprocess\.)/i.test(code)) permRisk += 0.4;
  if (/\bfs\.(read|write|unlink|chmod|chown|readdir)\b/i.test(code)) permRisk += 0.3;
  if (/\bprocess\.env\b|secret|password|credential/i.test(lower)) permRisk += 0.3;
  permRisk = clamp01(permRisk);

  // lib reputation (기본 0.65, 취약패키지 사용시 하향)
  let libRep = 0.65;
  if (/vulnerable[_-]?pkg[_-]?2023/.test(lower)) libRep = Math.min(libRep, 0.1);

  // Big-O 추정
  let bigO: BigOClass = "unknown";
  if (loopDepthApprox >= 3) bigO = "O(n^3)";
  else if (loopDepthApprox === 2) bigO = "O(n^2)";
  else if (sortHint || divideAndConquerHint) bigO = "O(n log n)";
  else if (loopDepthApprox === 1 || recursion) bigO = "O(n)";
  else bigO = "unknown";

  // 메모리/호출 카운트
  const memAllocs = (bufAlloc.length + arrAlloc.length + arrayLits.length + objectLits.length + mapSet);

  // CVE: 룰 + 벡터화 결합
  const regexRules = evaluateCveFromCodeRegex(code);
  const vectorRules = vectorCveScan(code);
  const cveSeverity01 = clamp01(1 - (1 - regexRules.severity01) * (1 - vectorRules.aggregatedSeverity01));

  // 이유 채우기 (증거 표시용)
  if (regexRules.hints.length) reasons.push(...regexRules.hints.map(h=>`regex:${h}`));
  if (vectorRules.matches.length) {
    reasons.push(...vectorRules.matches.map(m=>`vector:${m.id} sim=${m.similarity.toFixed(2)} sev=${m.severity01.toFixed(2)}`));
  }
  if (regexDosHint) reasons.push("ReDoS pattern suspected");
  if (divideAndConquerHint) reasons.push("Divide-and-conquer recursion hint");
  if (sortHint) reasons.push("Sort usage hint");

  return {
    bigO,
    cc,
    loopCount,
    loopDepthApprox,
    recursion,
    divideAndConquerHint,
    sortHint,
    regexDosHint,
    memAllocs,
    memBytesApprox,
    externalCalls,
    ioCalls,
    cveSeverity01,
    libReputation01: libRep,
    licenseMismatch: false,
    permRisk01: permRisk,
    _reasons: reasons
  };
}

/* ---------- 정규식 기반 CVE 룰 ---------- */
function evaluateCveFromCodeRegex(code: string) {
  const rules = [
    { id:"CVE-CMD-EXEC", rx:/\b(os\.system|subprocess\.(Popen|call|run)|child_process\.(exec|spawn)|Runtime\.getRuntime\(\)\.exec|system\()/i, sev:0.95, hint:"command execution" },
    { id:"CVE-SQLI-CONCAT", rx:/\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,200}\b(user|username|name|pwd|password)\b[\s\S]{0,60}("|'|`|\)|\})?\s*(\+|%s|format\(|f")/i, sev:0.90, hint:"sql concat" },
    { id:"CVE-PLAINTEXT-PWD", rx:/\b(mysql\.user|INSERT\s+INTO\s+mysql\.user|password\s*[:=]\s*["'`][^"'`]{1,64}["'`])/i, sev:0.85, hint:"plaintext password" },
    { id:"CVE-VULN-PKG", rx:/\b(import|require)\s+.*vulnerable[_-]?pkg[_-]?2023\b/i, sev:0.90, hint:"vulnerable package" }
  ];
  let sevAgg = 0;
  const hints: string[] = [];
  for (const r of rules) {
    if (r.rx.test(code)) {
      sevAgg = 1 - (1 - sevAgg) * (1 - r.sev);
      hints.push(r.hint);
    }
  }
  return { severity01: clamp01(sevAgg), hints };
}

/* ---------- 정적 파이프라인 실행 ---------- */
async function runStaticPipeline(code: string, filename: string|null|undefined, _language: string): Promise<StaticMetrics> {
  const lineCount = (code.match(/\n/g) || []).length + 1;

  // 기능성(F) 근사
  const totalApis = Math.max(1, (code.match(/\bexport\s+(function|class|interface|type|const|let|var)\b/g) || []).length || 5);
  const coreTouched = !!filename && /(\/|^)(core|service|domain)\//i.test(filename);
  const diffChangedLines = Math.min(200, Math.round(lineCount*0.2));
  const schemaChanged = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|MIGRATION)\b/i.test(code);

  // 정밀 리소스/보안
  const pr = preciseResourceAndSecurityScan(code);

  const metrics: StaticMetrics = {
    // SF
    apiChanges: 0,
    totalApis,
    coreTouched,
    diffChangedLines,
    totalLines: Math.max(1, lineCount),
    schemaChanged,

    // SR
    bigO: pr.bigO,
    cc: pr.cc,
    loopCount: pr.loopCount,
    loopDepthApprox: pr.loopDepthApprox,
    recursion: pr.recursion,
    divideAndConquerHint: pr.divideAndConquerHint,
    sortHint: pr.sortHint,
    regexDosHint: pr.regexDosHint,

    memAllocs: pr.memAllocs,
    memBytesApprox: pr.memBytesApprox,
    externalCalls: pr.externalCalls,
    ioCalls: pr.ioCalls,

    // SD
    cveSeverity01: pr.cveSeverity01,
    libReputation01: pr.libReputation01,
    licenseMismatch: pr.licenseMismatch,
    permRisk01: pr.permRisk01,

    _reasons: pr._reasons
  };

  return metrics;
}

/* ---------- 가중치 ---------- */
const WF = { api: 0.40, core: 0.25, diff: 0.20, schema: 0.15 };
const WR = { bigO: 0.32, cc: 0.18, mem: 0.22, ext: 0.18, io: 0.10 };
const WD = { cve: 0.42, rep: 0.25, lic: 0.10, perm: 0.23 };

/* ---- 차원 점수 계산 ---- */
function computeFSignalsFromMetrics(m: StaticMetrics) {
  const apiRatio  = clamp01(m.apiChanges / Math.max(1, m.totalApis));
  const diffRatio = clamp01(m.diffChangedLines / Math.max(1, m.totalLines));
  const v = apiRatio*WF.api + (m.coreTouched?1:0)*WF.core + diffRatio*WF.diff + (m.schemaChanged?1:0)*WF.schema;
  return clamp01(v);
}
function computeRSignalsFromMetrics(m: StaticMetrics) {
  const bigO = mapBigOTo01(m.bigO);
  const ccNorm = clamp01(1 - Math.exp(-0.12 * Math.max(0, m.cc - 1)));
  const memByteNorm = clamp01(Math.log2(Math.max(1, m.memBytesApprox)) / 24);
  const memAllocNorm = clamp01(1 - Math.exp(-0.06 * m.memAllocs));
  const mem = clamp01(0.7 * memByteNorm + 0.3 * memAllocNorm);
  const ext  = clamp01(1 - Math.exp(-0.05 * m.externalCalls));
  const io   = clamp01(1 - Math.exp(-0.06 * m.ioCalls));
  const v = bigO*WR.bigO + ccNorm*WR.cc + mem*WR.mem + ext*WR.ext + io*WR.io;
  return clamp01(v);
}
function computeDSignalsFromMetrics(m: StaticMetrics) {
  const v = m.cveSeverity01*WD.cve + (1 - m.libReputation01)*WD.rep + (m.licenseMismatch?1:0)*WD.lic + m.permRisk01*WD.perm;
  return clamp01(v);
}

/* ---------- Static metrics → FRD 벡터 ---------- */
function analyzeFromStaticMetrics(metrics: StaticMetrics, filename?: string | null) {
  const F = computeFSignalsFromMetrics(metrics);
  const R = computeRSignalsFromMetrics(metrics);
  const D = computeDSignalsFromMetrics(metrics);

  const vector: [number, number, number] = [F, R, D];

  const signalTable = {
    F: { apiRatio: clamp01(metrics.apiChanges / Math.max(1, metrics.totalApis)),
         coreModuleModified: metrics.coreTouched ? 1 : 0,
         diffLineRatio: clamp01(metrics.diffChangedLines / Math.max(1, metrics.totalLines)),
         schemaChanged: metrics.schemaChanged ? 1 : 0 },
    R: { timeComplexity: mapBigOTo01(metrics.bigO),
         cyclomaticComplexity: metrics.cc,
         loopDepthApprox: metrics.loopDepthApprox,
         memBytesApprox: metrics.memBytesApprox,
         memNorm: clamp01(0.7*(Math.log2(Math.max(1, metrics.memBytesApprox))/24) + 0.3*(1 - Math.exp(-0.06 * metrics.memAllocs))),
         externalCallNorm: clamp01(1 - Math.exp(-0.05 * metrics.externalCalls)),
         ioCallNorm: clamp01(1 - Math.exp(-0.06 * metrics.ioCalls)) },
    D: { cveSeverity: metrics.cveSeverity01,
         libReputation: metrics.libReputation01,
         licenseMismatch: metrics.licenseMismatch ? 1 : 0,
         sensitivePerm: metrics.permRisk01 }
  };

  return { vector, filename, signalTable, reasons: metrics._reasons };
}

/* ---------- CRAI 식(2) ---------- */
function scoreFromVector(v: number[], top?: { wF:number; wR:number; wD:number }) {
  const cfg = top ?? { wF: 0.40, wR: 0.30, wD: 0.30 };

  const SF = clamp01(v[0]);
  const SR = clamp01(v[1]);
  const SD = clamp01(v[2]);

  const B = 10 * (cfg.wF * SF + cfg.wR * SR + cfg.wD * SD);

  const wrSum = cfg.wF + cfg.wR;
  const mixFR = wrSum > 0 ? (cfg.wF / wrSum) * SF + (cfg.wR / wrSum) * SR : 0;
  const C = Math.min(10, 10 * (SD + (1 - SD) * mixFR));

  const rho = SD / (SF + SR + SD + 1e-6);
  const s = smoothstep(SD, 0.4, 0.7);
  const alpha = s * (0.5 + 0.5 * rho);

  const craiRaw = (1 - alpha) * B + alpha * C;
  const score = Math.min(10, craiRaw);

  let severity: "green" | "yellow" | "orange" | "red" = "green";
  let level = "LOW";
  let action = "Quick scan sufficient";

  if (score >= 9.0) {
    severity = "red";
    level = "CRITICAL";
    action = "Comprehensive audit needed";
  } else if (score >= 7.0) {
    severity = "orange";
    level = "HIGH";
    action = "Detailed review required";
  } else if (score >= 4.0) {
    severity = "yellow";
    level = "MEDIUM";
    action = "Standard review process";
  }

  return {
    score, severity, level, action, weights: cfg,
    crai_components: { B, C, alpha, rho, s, SF, SR, SD, mixFR }
  };
}

/* ----- smoothstep 스무딩 함수 ----- */
function smoothstep(x: number, a: number, b: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/* ---------- Filename hint ---------- */
function detectSuggestedFileName(fullText: string, _fallbackLang?: string | null): string | null {
  const re = /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*)([A-Za-z0-9_\-./]+?\.[A-Za-z]{1,8})/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(fullText)) !== null) last = m[1];
  if (!last) return null;

  const extMatch = last.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!extMatch) return null;
  const ext = extMatch[1];
  if (!/[A-Za-z]/.test(ext)) return null;
  if (/^\d+(\.\d+)+$/.test(last)) return null;
  if (last.includes("..")) return null;

  return last.replace(/^\/+/, "");
}

/* ======================================================================
 *  승인 후 코드 적용
 * ==================================================================== */
async function handleApproval(code: string, language: string, suggested?: string | null) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
    return;
  }

  const shellCmdPattern = /^(npm|yarn|pip|pip3|pnpm|apt|apt-get|brew|git|chmod|chown|sudo|rm|mv|cp|mkdir|rmdir|systemctl|service|curl|bash)\b/i;
  const firstLine = (code || "").trim().split(/\r?\n/)[0] || "";
  const looksLikeShell = language === "bash" || language === "sh" || shellCmdPattern.test(firstLine);

  const denylist = [
    /\brm\s+-rf?\s+\/?[^]*?/i,
    /\bsudo\b/i,
    /\bchown\b/i,
    /\bmkfs\w*\b/i,
    /\bdd\s+if=\/dev\/zero\b/i,
    /\bshutdown\b|\breboot\b/i,
    /\bcurl\b.*\|\s*sh\b/i
  ];

  if (looksLikeShell) {
    if (denylist.some(rx => rx.test(code))) {
      vscode.window.showErrorMessage("위험 명령이 감지되어 실행을 차단했습니다.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "터미널 명령으로 감지되었습니다. 통합 터미널에서 실행할까요?",
      { modal: true }, "실행", "취소"
    );
    if (confirm !== "실행") return;

    const termName = "AI Approval Agent";
    let terminal = vscode.window.terminals.find(t => t.name === termName);
    if (!terminal) terminal = vscode.window.createTerminal({ name: termName });
    terminal.show(true);

    const lines = code.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    for (const line of lines) terminal.sendText(line, true);
    vscode.window.showInformationMessage(`터미널에서 ${lines.length}개 명령을 실행했습니다.`);
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: "Overwrite current file", description: "활성 에디터의 전체 내용을 교체" },
      { label: "Insert at cursor",       description: "활성 에디터의 현재 커서 위치에 삽입" },
      { label: "Save as new file",       description: "새 파일로 저장 (현재 동작)" }
    ],
    { placeHolder: "승인된 코드를 어디에 적용할까요?" }
  );
  if (!choice) return;

  if (choice.label === "Overwrite current file") {
    const uri = await overwriteActiveEditor(code);
    if (uri) vscode.window.showInformationMessage(`현재 파일에 덮어썼습니다: ${uri.fsPath}`);
    return;
  }

  if (choice.label === "Insert at cursor") {
    const uri = await insertAtCursor(code);
    if (uri) vscode.window.showInformationMessage(`현재 파일 커서 위치에 삽입했습니다: ${uri.fsPath} (저장은 Ctrl/Cmd+S)`);
    return;
  }

  const root = vscode.workspace.workspaceFolders[0].uri;
  const ext = guessExtension(language);
  const targetRel = sanitizeRelativePath(suggested) || (await nextAutoName(root, ext));

  await ensureParentDir(root, targetRel);
  const fileUri = vscode.Uri.joinPath(root, targetRel);

  const enc = new TextEncoder();
  await vscode.workspace.fs.writeFile(fileUri, enc.encode(code));
  vscode.window.showInformationMessage(`승인됨 → ${targetRel} 저장 완료`);

  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
}

/* --- 활성 에디터 전체 덮어쓰기 --- */
async function overwriteActiveEditor(code: string): Promise<vscode.Uri | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("활성 텍스트 에디터가 없습니다.");
    return null;
  }
  const doc = editor.document;
  if (doc.isClosed) {
    vscode.window.showErrorMessage("활성 문서를 열 수 없습니다.");
    return null;
  }

  const lastLine = doc.lineAt(Math.max(0, doc.lineCount - 1));
  const fullRange = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);

  await editor.edit((eb) => eb.replace(fullRange, code));
  await doc.save();
  return doc.uri;
}

/* --- 커서 위치 삽입 --- */
async function insertAtCursor(code: string): Promise<vscode.Uri | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("활성 텍스트 에디터가 없습니다.");
    return null;
  }
  const doc = editor.document;
  if (doc.isClosed) {
    vscode.window.showErrorMessage("활성 문서를 열 수 없습니다.");
    return null;
  }

  const pos = editor.selection.active;
  await editor.edit((eb) => eb.insert(pos, code));
  return doc.uri;
}

/* ---------- Fs utils ---------- */
function guessExtension(language: string): string {
  const map: Record<string, string> = {
    javascript: "js", typescript: "ts", python: "py",
    html: "html", css: "css", java: "java",
    c: "c", cpp: "cpp", tsx: "tsx", jsx: "jsx",
    json: "json", plaintext: "txt", bash: "sh", sh: "sh", kotlin: "kt"
  };
  const key = (language || "").toLowerCase().trim();
  return map[key] || (key.match(/^[a-z0-9]+$/) ? key : "txt");
}

function sanitizeRelativePath(p?: string | null): string | null {
  if (!p) return null;
  if (p.includes("..")) return null;
  return p.replace(/^\/+/, "").trim();
}

async function nextAutoName(root: vscode.Uri, ext: string): Promise<string> {
  const base = "generated_code";
  for (let i = 1; i <= 9999; i++) {
    const name = `${base}_${String(i).padStart(3, "0")}.${ext}`;
    const uri = vscode.Uri.joinPath(root, name);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return name;
    }
  }
  return `${base}_${Date.now()}.${ext}`;
}

async function ensureParentDir(root: vscode.Uri, relPath: string) {
  const parts = relPath.split("/").slice(0, -1);
  if (!parts.length) return;
  let cur = root;
  for (const part of parts) {
    cur = vscode.Uri.joinPath(cur, part);
    try {
      await vscode.workspace.fs.stat(cur);
    } catch {
      await vscode.workspace.fs.createDirectory(cur);
    }
  }
}

/* ---------- HTML / Nonce ---------- */
function getHtml(webview: vscode.Webview, ctx: vscode.ExtensionContext, nonce: string): string {
  const base = vscode.Uri.joinPath(ctx.extensionUri, "src", "webview");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(base, "styles.css"));

  const csp = `
    default-src 'none';
    img-src ${webview.cspSource} https: data:;
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource};
  `;

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="${css}">
  <style>
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ddd);
      font-family: var(--vscode-font-family, "Segoe UI", Roboto, "Helvetica Neue", Arial);
    }

    .chat {
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
      padding: 10px;
    }

    .chat-header {
      font-weight: 700;
      font-size: 16px;
      margin-bottom: 10px;
    }

    .chat-body {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      background: var(--vscode-sideBar-background, #252526);
      border-radius: 6px;
      box-shadow: inset 0 0 3px rgba(0,0,0,0.4);
      margin-bottom: 10px;
    }

    #composer {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
    }

    #composer #prompt {
      flex: 1 1 auto;
      width: 100%;
      min-width: 0;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ddd);
      font-size: 13px;
      box-sizing: border-box;
    }

    #composer button {
      flex: 0 0 auto;
      padding: 8px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      font-weight: 600;
      font-size: 13px;
      transition: background 0.15s ease-in-out;
    }

    #composer button:hover {
      background: var(--vscode-button-hoverBackground, #0b7dd8);
    }
  </style>
  <title>AI Approval Agent</title>
</head>
<body>
  <section class="chat">
    <div class="chat-header">AI Approval Agent</div>
    <div class="chat-body" id="chat">
      <div class="msg bot">
        How can I help? If you request "code generation," you can choose to approve or reject the generated code.
      </div>
    </div>
    <form id="composer">
      <input id="prompt" type="text" placeholder="Ex) Generate starter code for an Express server." />
      <button type="submit">Send</button>
    </form>
  </section>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** 마지막 코드블록 추출 (```lang\ncode```) — Extension Host 런타임용 */
function extractLastCodeBlockTS(text: string): { language: string; code: string } | null {
  const regex = /```([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;

  while ((match = regex.exec(text)) !== null) last = match[1];
  if (!last) return null;

  const nl = last.indexOf("\n");
  if (nl > -1) {
    const maybeLang = last.slice(0, nl).trim();
    const body = last.slice(nl + 1);
    if (/^[a-zA-Z0-9+#._-]{0,20}$/.test(maybeLang)) {
      return { language: maybeLang || "plaintext", code: body };
    }
  }
  return { language: "plaintext", code: last };
}

export function deactivate() {}
