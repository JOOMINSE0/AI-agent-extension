// VS Code 확장에 필요한 기본 모듈 import (전체 파이프라인 공통 인프라, SF/SR/SD 모두의 기반)
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

// CRAI 기반 AI Approval Agent 확장 활성화 진입점 (전체 SF/SR/SD 계산을 트리거하는 엔트리)
export function activate(context: vscode.ExtensionContext) {
  console.log("AI Approval Agent is now active!");

  // SD: CVE 룰 DB 로드(정규식 기반) → Dependency 위험(SD)에 사용
  RULE_DB = loadGeneratedRuleDb(context);
  if (RULE_DB.length) {
    console.log(`[CVE] Loaded generated RULE DB: ${RULE_DB.length} signature(s)`);
  } else {
    console.warn("[CVE] WARNING: generated_cve_rules.json not found or empty. Regex scoring -> 0");
  }

  // SD: CVE 벡터 DB 로드(코사인 기반) → Dependency 위험(SD)에 사용
  DYN_CVE_DB = loadGeneratedCveDb(context);
  if (DYN_CVE_DB.length) {
    console.log(`[CVE] Loaded generated VECTOR DB: ${DYN_CVE_DB.length} signature(s)`);
  } else {
    console.warn("[CVE] WARNING: generated_cve_db.json not found or empty. Vector scoring -> 0");
  }

  // SF/SR/SD 분석 결과를 보여주는 Webview 뷰 프로바이더 등록 (UI 레이어)
  const provider = new ApprovalViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("aiApprovalView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 패널 오픈 명령 등록 (UI용)
  context.subscriptions.push(
    vscode.commands.registerCommand("ai-approval-agent.showPanel", () => {
      vscode.window.showInformationMessage("AI Approval Panel opened!");
    })
  );
}

// Ollama 응답에서 추출한 코드블록을 관리하기 위한 타입 및 상태 (SF/SR/SD 계산 대상 코드 컨테이너)
type Snippet = { language: string; code: string; suggested?: string | null };
let LAST_SNIPPETS: Snippet[] = [];

// Webview를 제공하는 뷰 프로바이더 구현 (UI → 확장으로 메시지 연결, SF/SR/SD 결과를 뷰로 전달)
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

// 설정 파일에서 Ollama 엔드포인트 및 가중치 설정을 읽어오는 함수
//  → CRAI 최종 점수에서 SF/SR/SD 가중치(wF, wR, wD)를 동적으로 조정 (scoreFromVector에서 사용)
function getCfg() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    endpoint: (cfg.get<string>("aiApproval.ollama.endpoint") || "http://210.110.103.64:11434").replace(/\/$/, ""),
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3.1:8b",
    wF: cfg.get<number>("aiApproval.weights.functionality") ?? 0.40, // SF 가중치
    wR: cfg.get<number>("aiApproval.weights.resource") ?? 0.30,      // SR 가중치
    wD: cfg.get<number>("aiApproval.weights.dependency") ?? 0.30     // SD 가중치
  };
}

// Webview와 확장 사이의 메시지 핸들링(Ask/Approve/Reject 등)을 담당하는 함수
//  - "ask": Ollama로부터 코드 생성 → runStaticPipeline → analyzeFromStaticMetrics → scoreFromVector
//    → SF/SR/SD + CRAI 점수를 계산하고 Webview에 전달
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "approve": {
          const { mode } = msg || {};

          // SD 결과(Dependency 위험)에 의해 점수가 높아져 severity가 red인 경우, CONFIRM 게이트 (CRAI 결과 기반 게이트)
          if (msg?.severity === "red") {
            const input = await vscode.window.showInputBox({
              prompt: `High risk (${msg?.score}). Type 'CONFIRM' to continue.`,
              validateInput: (v) => (v === "CONFIRM" ? null : "You must type CONFIRM to proceed.")
            });
            if (input !== "CONFIRM") return;
          }

          // SF/SR/SD 분석 결과에 따라 사용자가 승인한 코드(LAST_SNIPPETS)를 실제 워크스페이스에 반영
          if (mode === "one" || mode === "all") {
            if (!LAST_SNIPPETS.length) {
              vscode.window.showWarningMessage("승인할 코드가 없습니다. 먼저 'Ask'로 코드를 생성하세요.");
              return;
            }
            if (mode === "one") {
              const index = typeof msg.index === "number" ? msg.index : -1;
              if (index < 0 || index >= LAST_SNIPPETS.length) {
                vscode.window.showErrorMessage("잘못된 코드블록 인덱스입니다.");
                return;
              }
              const snip = LAST_SNIPPETS[index];
              await handleApproval(snip.code, snip.language, snip.suggested);
              break;
            }
            if (mode === "all") {
              await handleApprovalMany(LAST_SNIPPETS);
              break;
            }
          } else {
            const { code = "", language = "plaintext" } = msg || {};
            await handleApproval(code, language, null);
          }
          break;
        }

        case "reject": {
          // 사용자가 CRAI(SF/SR/SD 기반) 결과를 보고 코드를 거부한 경우
          vscode.window.showWarningMessage("Rejected (not saved or executed).");
          break;
        }

        case "details": {
          // Webview 카드에 표시된 SF/SR/SD 상세 사유를 확인하도록 안내 (UI-only)
          vscode.window.showInformationMessage("View details: the reason is shown on the card.");
          break;
        }

        case "ask": {
          // Ollama 호출 → 코드 생성 → SF/SR/SD 분석의 입구
          const { endpoint, model, wF, wR, wD } = getCfg();
          try {
            // Ollama와 스트리밍으로 대화 (코드 텍스트 획득 단계, SF/SR/SD와 직접적 계산은 여기서 x)
            const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
              webview.postMessage({ type: "delta", text: delta });
            });

            // 생성된 응답에서 코드블록 추출 (SF/SR/SD 분석 대상 코드 목록)
            const blocks = extractCodeBlocksTS(fullText);
            LAST_SNIPPETS = blocks.map((b) => ({
              language: b.language,
              code: b.code,
              suggested: detectSuggestedFileName(b.code, b.language)
            }));

            // SF/SR/SD 분석은 기본적으로 마지막 코드블록(primary)에 대해 수행
            const primary =
              LAST_SNIPPETS.length > 0
                ? LAST_SNIPPETS[LAST_SNIPPETS.length - 1]
                : { language: "plaintext", code: "", suggested: null };

            const globalSuggested =
              detectSuggestedFileName(fullText, primary.language) || primary.suggested || null;

            // ★ runStaticPipeline: 정적 분석 전체 파이프라인
            //   - SF: computeFSignalsSemantic, coreTouched, apiChanges, schemaChanged 등
            //   - SR: Big-O, CC, 메모리, 외부/IO 호출
            //   - SD: CVE 스캔, 라이브러리 평판, 권한 위험
            const metrics = await runStaticPipeline(primary.code, globalSuggested, primary.language);

            // ★ analyzeFromStaticMetrics:
            //   - SF: F 값 (Functionality)
            //   - SR: R 값 (Resource)
            //   - SD: D 값 (Dependency)
            const heur = analyzeFromStaticMetrics(metrics, globalSuggested);
            const fusedVector = heur.vector; // [SF, SR, SD]

            // ★ scoreFromVector:
            //   - FRD 벡터([SF, SR, SD])와 가중치(wF, wR, wD)로 CRAI 점수 계산
            const scored = scoreFromVector(fusedVector, { wF, wR, wD });

            const dbWarns: string[] = [];
            if (!RULE_DB.length) dbWarns.push("generated_cve_rules.json not loaded → regex score = 0");
            if (!DYN_CVE_DB.length) dbWarns.push("generated_cve_db.json not loaded → vector score = 0");

            // Webview로 SF/SR/SD와 CRAI 구성요소를 모두 전달
            webview.postMessage({
              type: "analysis",
              vector: fusedVector,                       // [SF, SR, SD]
              score: scored.score,                       // CRAI 점수
              severity: scored.severity,                 // CRAI 심각도
              level: scored.level,                       // CRAI 레벨(LOW/MEDIUM/HIGH/CRITICAL)
              weights: scored.weights,                   // wF, wR, wD
              suggestedFilename: globalSuggested || null,
              language: primary.language,
              code: primary.code,
              reasons: [...heur.reasons, ...dbWarns.map((w) => `warn:${w}`)],
              crai_components: scored.crai_components,   // B, C, alpha, rho, s, SF, SR, SD 등 내부 구성
              signalTable: heur.signalTable,             // FRD 각각의 내부 시그널 테이블
              breakdown: { heurOnly: { vector: heur.vector, ...scored } },
              blocks: LAST_SNIPPETS.map((b, i) => ({
                index: i,
                language: b.language,
                suggested: b.suggested || null,
                preview: (b.code || "").split(/\r?\n/, 2).join("\n"),
                length: b.code.length
              }))
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

// Ollama와 스트리밍 방식으로 대화하고 전체 응답 텍스트를 반환하는 함수
//  → SF/SR/SD 분석용 "원본 코드 텍스트"를 가져오는 단계 (FRD 계산의 입력 준비)
async function chatWithOllamaAndReturn(
  endpoint: string,
  model: string,
  userText: string,
  onDelta: (text: string) => void
): Promise<string> {
  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) return "";

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
      }
    }
  }
  return full;
}

// CVE 정규식 룰 DB, 토크나이저 룰, 벡터 시그니처 타입 정의
//  → Dependency 차원(SD)에서 취약점 및 의존성 위험을 수치화하기 위한 구조
type Rule = { rx: string; w: number; note?: string; token?: string; support?: number; idf?: number };
type TokenizerRule = { name?: string; rx: string; w?: number };
type Sig = {
  id: string;
  title: string;
  baseSeverity: number;
  rules: Rule[];
  cooccur?: { all: string[]; bonus: number }[];
  proximity?: { a: string; b: string; lines: number; bonus: number }[];
  negatives?: { rx: string; penalty: number; note?: string }[];
  group?: string;
  support_docs?: number;
  tokenizer_rules?: TokenizerRule[];
};

type CveVectorSig = {
  id: string;
  title: string;
  tokens: Record<string, number>;
  baseSeverity: number;
  notes?: string;
  token_regex?: TokenizerRule[];
};

// 동적으로 로드된 CVE 룰/벡터 DB 전역 상태 (SD: Dependency 위험 계산용 핵심 데이터)
let RULE_DB: Sig[] = [];
let DYN_CVE_DB: CveVectorSig[] = [];

// generated_cve_rules.json 파일을 로드하는 함수 (SD: 정규식 기반 취약점 룰 세트 초기화)
function loadGeneratedRuleDb(ctx?: vscode.ExtensionContext): Sig[] {
  try {
    const base = ctx ? ctx.extensionUri.fsPath : process.cwd();
    const p = path.join(base, "cve_data", "generated_cve_rules.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    const arr = obj?.signatures as Sig[] | undefined;
    (RULE_DB as any) = arr || [];
    (RULE_DB as any).tokenizer_rules = obj?.tokenizer_rules || [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error("[CVE] loadGeneratedRuleDb error:", e);
    return [];
  }
}

// generated_cve_db.json 벡터 DB를 로드하는 함수 (SD: 벡터 기반 취약점 시그니처 초기화)
function loadGeneratedCveDb(ctx?: vscode.ExtensionContext): CveVectorSig[] {
  try {
    const base = ctx ? ctx.extensionUri.fsPath : process.cwd();
    const p = path.join(base, "cve_data", "generated_cve_db.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw) as CveVectorSig[];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error("[CVE] loadGeneratedCveDb error:", e);
    return [];
  }
}

// 현재 사용 가능한 벡터 DB를 반환하는 헬퍼 (SD: Dependency 위험 계산에서 사용하는 시그니처 집합)
function getSigDB(): CveVectorSig[] {
  return Array.isArray(DYN_CVE_DB) ? DYN_CVE_DB : [];
}

// 룰/벡터 DB에서 토큰화에 쓸 정규식 패턴을 수집하는 함수
//  → SD: 코드에서 취약점 패턴 토큰을 추출하기 위한 토크나이저 정의
function collectTokenizerPatterns() {
  const globalRules: TokenizerRule[] = [];
  const rootRules = (RULE_DB as any)?.tokenizer_rules as TokenizerRule[] | undefined;
  if (Array.isArray(rootRules)) globalRules.push(...rootRules);

  for (const sig of RULE_DB || []) {
    const arr = sig.tokenizer_rules as TokenizerRule[] | undefined;
    if (Array.isArray(arr)) globalRules.push(...arr);
  }

  const perSigRegex: TokenizerRule[] = [];
  for (const sig of DYN_CVE_DB || []) {
    const arr = sig.token_regex as TokenizerRule[] | undefined;
    if (Array.isArray(arr)) perSigRegex.push(...arr);
  }

  return { globalRules, perSigRegex };
}

// 코드 문자열을 CVE 토큰 벡터(가중치 포함)로 변환하는 함수
//  → SD: 코드에서 발견된 취약점 관련 토큰을 벡터로 표현하여 Dependency 위험(SD) 계산에 사용
function vectorizeCodeToTokens(code: string): Record<string, number> {
  const lower = code.toLowerCase();
  const feats: Record<string, number> = {};
  const add = (k: string, w = 1) => { feats[k] = (feats[k] ?? 0) + w; };

  const sigDB = getSigDB();
  if (sigDB.length) {
    for (const sig of sigDB) {
      const tokTable = sig.tokens || {};
      for (const [tok, wRaw] of Object.entries(tokTable)) {
        const w = typeof wRaw === "number" ? wRaw : 1;
        if (!tok) continue;
        const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wordLike = /^[A-Za-z0-9_]+$/.test(tok);
        const re = wordLike ? new RegExp(`\\b${esc}\\b`, "i") : new RegExp(esc, "i");
        if (re.test(lower)) add(tok, w);
      }
    }
  }

  const { globalRules, perSigRegex } = collectTokenizerPatterns();
  for (const r of [...globalRules, ...perSigRegex]) {
    if (!r?.rx) continue;
    try {
      const re = new RegExp(r.rx, "i");
      if (re.test(lower)) add(r.name || r.rx, r.w ?? 1);
    } catch {
    }
  }

  return feats;
}

// 두 벡터 간 코사인 유사도를 계산하는 함수
//  → SD: 코드 토큰 벡터 vs CVE 시그니처 벡터 유사도를 통해 Dependency 위험 정도 추정
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

// 코드 벡터와 CVE 벡터 DB를 비교해 위험도 및 상위 매칭 결과를 산출하는 함수
//  → SD: D 차원에서 cveSeverity01에 반영되는 "벡터 기반 취약점 위험" 계산
function vectorCveScan(code: string) {
  const DB = getSigDB();
  if (!DB.length) return { aggregatedSeverity01: 0, matches: [] as any[] };

  const codeVec = vectorizeCodeToTokens(code);
  const results = DB.map((sig) => {
    const sim = cosineSim(codeVec, sig.tokens || {});
    const base = clamp01(sig.baseSeverity ?? 0.7);
    const sev = clamp01(base * Math.min(1, Math.pow(Math.max(0, sim), 0.8) * 1.2));
    return { id: sig.id, title: sig.title, similarity: sim, severity01: sev, notes: sig.notes ?? "" };
  }).sort((a, b) => b.severity01 - a.severity01);

  const topK = results.slice(0, 3);
  let agg = 0;
  for (const r of topK) agg = 1 - (1 - agg) * (1 - r.severity01);

  return { aggregatedSeverity01: Math.min(1, agg), matches: results.filter((r) => r.similarity > 0.15).slice(0, 5) };
}

// 정규식 룰 DB를 이용해 CVE 위험도를 계산하는 함수
//  → SD: D 차원에서 cveSeverity01에 반영되는 "정규식 기반 취약점 위험" 계산
function regexHeuristicScoreFromDB(code: string, db: Sig[]) {
  if (!db?.length) return { severity01: 0, matches: [] as any[] };

  const lower = code.toLowerCase();
  const lines = lower.split(/\r?\n/);
  const RX = (rx: string) => new RegExp(rx, "i");

  const results = db.map((sig) => {
    let raw = 0;
    const matched: string[] = [];

    for (const r of sig.rules || []) {
      try {
        const re = RX(r.rx);
        if (re.test(lower)) {
          const w = (r.w ?? 1) * (r.idf ?? 1);
          raw += w;
          matched.push(r.token || r.rx);
        }
      } catch {
      }
    }

    sig.cooccur?.forEach((c) => {
      const ok = (c.all || []).every((rx) => { try { return RX(rx).test(lower); } catch { return false; } });
      if (ok) raw += c.bonus || 0;
    });

    sig.proximity?.forEach((p) => {
      try {
        const A = RX(p.a), B = RX(p.b);
        const L = p.lines ?? 5;
        for (let i = 0; i < lines.length; i++) {
          if (!A.test(lines[i])) continue;
          for (let d = -L; d <= L; d++) {
            const j = i + d;
            if (j >= 0 && j < lines.length && B.test(lines[j])) { raw += p.bonus || 0; d = L + 1; break; }
          }
        }
      } catch {
      }
    });

    sig.negatives?.forEach((n) => { try { if (RX(n.rx).test(lower)) raw -= n.penalty || 0; } catch {} });

    const base = clamp01(sig.baseSeverity ?? 0.7);
    const supBoost = Math.min(0.10, (Math.max(0, sig.support_docs ?? 0) / 1000));
    const sev = clamp01((base * (1 + supBoost)) * (1 - Math.exp(-3 * Math.max(0, raw))));

    return { id: sig.id, title: sig.title, severity01: sev, matched, raw: Number(Math.max(0, raw).toFixed(3)) };
  }).sort((a, b) => b.severity01 - a.severity01);

  const topK = results.slice(0, 3);
  let agg = 0;
  for (const r of topK) agg = 1 - (1 - agg) * (1 - r.severity01);

  return {
    severity01: clamp01(agg),
    matches: results.filter((r) => r.severity01 > 0.15).slice(0, 5)
  };
}

// AST 기반 호출 그래프를 표현하기 위한 타입 및 구조체 정의
//  → SF: 기능적 영향도(Functionality)를 계산하기 위한 호출 그래프 구조
type CGNodeId = string;
type CallGraph = {
  nodes: Set<CGNodeId>;
  edges: Map<CGNodeId, Set<CGNodeId>>;
  indeg: Map<CGNodeId, number>;
  outdeg: Map<CGNodeId, number>;
  entrypoints: Set<CGNodeId>;
  changed: Set<CGNodeId>;
};

// 함수/핸들러가 엔트리포인트인지 추정하는 휴리스틱 함수
//  → SF: 사용자 요청/외부 인터페이스에 가까운 노드를 엔트리포인트로 간주해 기능 영향도 측정
function isProbableEntrypoint(name: string, isExported: boolean, fileText: string): boolean {
  if (isExported) return true;
  if (/\b(app|router)\.(get|post|put|delete|patch)\s*\(/.test(fileText)) return true;
  if (/\bexport\s+default\b/.test(fileText) && /handler|route|loader/i.test(name)) return true;
  return false;
}

// TypeScript AST로부터 호출 그래프를 구성하는 함수
//  → SF: 엔트리포인트/함수 간 호출 관계를 분석해 Functionality 영향도(SF) 신호에 활용
function buildCallGraphFromTS(code: string, virtFileName = "snippet.ts"): CallGraph {
  const src = ts.createSourceFile(virtFileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cg: CallGraph = {
    nodes: new Set(),
    edges: new Map(),
    indeg: new Map(),
    outdeg: new Map(),
    entrypoints: new Set(),
    changed: new Set(),
  };

  const fileText = code;
  const decls: Array<{ id: CGNodeId; name: string; isExported: boolean; node: ts.Node }> = [];

  const idOf = (name: string) => `${virtFileName}::${name}`;
  const addNode = (id: CGNodeId) => {
    cg.nodes.add(id);
    if (!cg.edges.has(id)) cg.edges.set(id, new Set());
    if (!cg.indeg.has(id)) cg.indeg.set(id, 0);
    if (!cg.outdeg.has(id)) cg.outdeg.set(id, 0);
  };
  const addEdge = (from: CGNodeId, to: CGNodeId) => {
    addNode(from); addNode(to);
    const s = cg.edges.get(from)!;
    if (!s.has(to)) {
      s.add(to);
      cg.outdeg.set(from, (cg.outdeg.get(from) || 0) + 1);
      cg.indeg.set(to, (cg.indeg.get(to) || 0) + 1);
    }
  };

  const visitDecl = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(src);
      const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      decls.push({ id: idOf(name), name, isExported, node });
    } else if (ts.isVariableStatement(node)) {
      const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      node.declarationList.declarations.forEach(d => {
        const name = d.name.getText(src);
        if (d.initializer && (ts.isFunctionExpression(d.initializer) || ts.isArrowFunction(d.initializer))) {
          decls.push({ id: idOf(name), name, isExported, node: d.initializer });
        }
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.getText(src);
      const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      decls.push({ id: idOf(name), name, isExported, node });
    }
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(src);

  decls.forEach(d => {
    addNode(d.id);
    if (isProbableEntrypoint(d.name, d.isExported, fileText)) cg.entrypoints.add(d.id);
  });

  const nameToId = new Map<string, CGNodeId>();
  decls.forEach(d => nameToId.set(d.name, d.id));

  const collectCallsIn = (node: ts.Node, current: CGNodeId | null) => {
    if (ts.isCallExpression(node)) {
      let calleeName = "";
      if (ts.isIdentifier(node.expression)) {
        calleeName = node.expression.text;
      } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
        calleeName = node.expression.name.text;
      }
      if (calleeName && current && nameToId.has(calleeName)) {
        addEdge(current, nameToId.get(calleeName)!);
      }
    }
    ts.forEachChild(node, n => collectCallsIn(n, current));
  };

  decls.forEach(d => collectCallsIn(d.node, d.id));
  decls.forEach(d => cg.changed.add(d.id));

  return cg;
}

// 특정 노드 집합에서 도달 가능한 노드들을 찾는 DFS 함수
//  → SF: 변경된 함수들이 시스템에서 어느 범위까지 영향을 미치는지(Reachability)를 추정
function forwardReachable(cg: CallGraph, fromSet: Set<CGNodeId>): Set<CGNodeId> {
  const seen = new Set<CGNodeId>();
  const stack: CGNodeId[] = [...fromSet];
  while (stack.length) {
    const u = stack.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const outs = cg.edges.get(u) || new Set();
    outs.forEach(v => { if (!seen.has(v)) stack.push(v); });
  }
  return seen;
}

// 변경된 코드에서 특정 엔트리포인트까지 경로가 존재하는지 확인하는 함수
//  → SF: 엔트리포인트 영향 비율(impactedEntrypointRatio)을 계산하는데 활용
function anyPathToEntrypoint(cg: CallGraph, fromSet: Set<CGNodeId>, entry: CGNodeId): boolean {
  const reach = forwardReachable(cg, fromSet);
  return reach.has(entry);
}

// 변경 노드들의 중심성을 근사적으로 계산하는 함수
//  → SF: 호출 그래프에서 변경 노드가 얼마나 "중심적"인지(centrality)를 측정
function centralityApprox(cg: CallGraph, nodes: Set<CGNodeId>): number {
  let acc = 0;
  nodes.forEach(n => { acc += (cg.indeg.get(n) || 0) + (cg.outdeg.get(n) || 0); });
  const localAvg = nodes.size ? acc / nodes.size : 0;

  let total = 0;
  cg.nodes.forEach(n => { total += (cg.indeg.get(n) || 0) + (cg.outdeg.get(n) || 0); });
  const globalAvg = cg.nodes.size ? total / cg.nodes.size : 1;

  const raw = globalAvg ? (localAvg / (globalAvg * 2)) : 0;
  return clamp01(raw);
}

// TS/JS 코드에서 AST/호출그래프 기반 기능 영향도(SF) 신호를 계산하는 함수
//  → SF: Functionality 차원을 AST/호출 그래프 기반으로 재정의하는 핵심 로직
function computeFSignalsSemantic(code: string, language: string) {
  const lang = (language || "").toLowerCase();
  if (!(lang.includes("ts") || lang.includes("js") || lang === "plaintext")) return null;

  let cg: CallGraph;
  try {
    cg = buildCallGraphFromTS(code);
  } catch {
    return null;
  }
  if (cg.nodes.size === 0) return { score: 0, details: { reason: "no nodes" } };

  const reach = forwardReachable(cg, cg.changed);
  const reachableNodesRatio = Math.min(1, reach.size / Math.max(1, cg.nodes.size));

  let impactedEntrypoints = 0;
  cg.entrypoints.forEach(ep => { if (anyPathToEntrypoint(cg, cg.changed, ep)) impactedEntrypoints++; });
  const totalEntrypoints = Math.max(1, cg.entrypoints.size || 1);
  const impactedEntrypointRatio = Math.min(1, impactedEntrypoints / totalEntrypoints);

  const centralityScore = centralityApprox(cg, cg.changed);

  const w1 = 0.5, w2 = 0.3, w3 = 0.2;
  const score = clamp01(w1 * impactedEntrypointRatio + w2 * reachableNodesRatio + w3 * centralityScore);

  return {
    score,
    details: {
      impactedEntrypointRatio: Number(impactedEntrypointRatio.toFixed(3)),
      reachableNodesRatio: Number(reachableNodesRatio.toFixed(3)),
      centralityScore: Number(centralityScore.toFixed(3)),
      nodes: cg.nodes.size,
      entrypoints: cg.entrypoints.size
    }
  };
}

// 정적 분석 결과를 담는 메인 메트릭 타입 정의
//  - SF: apiChanges, coreTouched, diffChangedLines, schemaChanged, semanticF
//  - SR: bigO, cc, loopCount, loopDepthApprox, recursion, memAllocs, memBytesApprox, externalCalls, ioCalls
//  - SD: cveSeverity01, libReputation01, licenseMismatch, permRisk01
type BigOClass = "O(1)" | "O(log n)" | "O(n)" | "O(n log n)" | "O(n^2)" | "O(n^3)" | "unknown";
type StaticMetrics = {
  apiChanges: number;
  totalApis: number;
  coreTouched: boolean;
  diffChangedLines: number;
  totalLines: number;
  schemaChanged: boolean;

  semanticF?: {
    score: number;
    impactedEntrypointRatio: number;
    reachableNodesRatio: number;
    centralityScore: number;
  };

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

  cveSeverity01: number;
  libReputation01: number;
  licenseMismatch: boolean;
  permRisk01: number;

  _reasons: string[];
};

// 0~1 범위로 값을 클램핑하는 가벼운 유틸 함수 (SF/SR/SD 공통)
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Big-O 복잡도를 0~1 스케일로 매핑하는 함수
//  → SR: 시간 복잡도(Big-O)를 Resource 차원(SR)의 신호로 사용
function mapBigOTo01(bigO: BigOClass) {
  const lut: { [k in BigOClass]: number } = {
    "O(1)": 0.05,
    "O(log n)": 0.15,
    "O(n)": 0.20,
    "O(n log n)": 0.35,
    "O(n^2)": 0.70,
    "O(n^3)": 0.90,
    "unknown": 0.50
  };
  return lut[bigO] ?? 0.50;
}

// 포화형 스케일링을 위한 지수 기반 함수 (SR/SD에서 여러 신호를 정규화할 때 사용)
const sat01 = (x: number, k: number) => clamp01(1 - Math.exp(-k * Math.max(0, x)));

// 시간/공간 복잡도, 외부 호출, 권한 등을 정밀하게 스캔하는 함수
//  → SR: bigO, cc, loop, memAllocs, memBytesApprox, externalCalls, ioCalls
//  → SD: cveSeverity01, libReputation01, permRisk01, licenseMismatch
//  (즉, Resource(SR) + Dependency(SD) 차원에 대한 정밀 스캐너)
function preciseResourceAndSecurityScan(
  code: string
): Omit<
  StaticMetrics,
  "apiChanges" | "totalApis" | "coreTouched" | "diffChangedLines" | "totalLines" | "schemaChanged" | "semanticF"
> {
  const reasons: string[] = [];
  const lower = code.toLowerCase();

  const branches = (code.match(/\b(if|else if|case|catch|&&|\|\||\?[:]|for|while|switch|try)\b/g) || []).length;
  const cc = 1 + branches;

  const loopCount = (code.match(/\b(for|while|forEach|map\(|reduce\()/g) || []).length;
  const nestedLoop = /\b(for|while)\s*\([^)]*\)\s*{[^{}]*\b(for|while)\s*\(/s.test(code);
  const tripleNested = /\b(for|while)[\s\S]{0,300}\b(for|while)[\s\S]{0,300}\b(for|while)/s.test(code);
  const loopDepthApprox = tripleNested ? 3 : nestedLoop ? 2 : loopCount > 0 ? 1 : 0;

  const sortHint = /\b(sort\(|Collections\.sort|Arrays\.sort)\b/.test(code);
  const recursion =
    /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*{[\s\S]*?\b\1\s*\(/.test(code) ||
    /([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*=>[\s\S]*?\b\1\s*\(/.test(code);
  const divideAndConquerHint = recursion && /\b(mid|merge|partition|divide|conquer)\b/i.test(code);

  const regexDosHint = /(a+)+|(\.\*){2,}|(.*){2,}/.test(code) && /(re\.compile|new\s+RegExp)/.test(code);

  const externalCalls = (code.match(/\b(fetch|axios|request|http\.|https\.|jdbc|mongo|redis|sequelize|prisma)\b/gi) || [])
    .length;
  const ioCalls =
    (code.match(/\bfs\.(read|write|append|unlink|readdir|chmod|chown)|open\(|readFileSync|writeFileSync\b/gi) || [])
      .length;

  let memBytesApprox = 0;
  const inc = (n: number) => { memBytesApprox += Math.max(0, n); };

  const bufAlloc = [...code.matchAll(/Buffer\.alloc\s*\(\s*(\d+)\s*\)/gi)];
  bufAlloc.forEach((m) => inc(parseInt(m[1], 10)));

  const arrAlloc = [...code.matchAll(/\bnew\s+Array\s*\(\s*(\d+)\s*\)|\bArray\s*\(\s*(\d+)\s*\)\.fill/gi)];
  arrAlloc.forEach((m) => inc((parseInt(m[1] || m[2], 10) || 0) * 8));

  const strLits = [...code.matchAll(/(["'`])([^"'`\\]|\\.){1,200}\1/g)];
  strLits.forEach((m) => inc(m[0]?.length || 0));
  const arrayLits = [...code.matchAll(/\[([^\[\]]{0,400})\]/g)];
  arrayLits.forEach((m) => {
    const elems = m[1].split(",").length || 0;
    inc(elems * 16);
  });
  const objectLits = [...code.matchAll(/\{([^{}]{0,400})\}/g)];
  objectLits.forEach((m) => {
    const props = (m[1].match(/:/g) || []).length;
    inc(props * 24);
  });

  const mapSet = (code.match(/\bnew\s+(Map|Set)\s*\(/g) || []).length;
  inc(mapSet * 128);

  let permRisk = 0;
  if (/\b(child_process|exec\(|spawn\(|system\(|popen\(|subprocess\.)/i.test(code)) permRisk += 0.4;
  if (/\bfs\.(read|write|unlink|chmod|chown|readdir)\b/i.test(code)) permRisk += 0.3;
  if (/\bprocess\.env\b|secret|password|credential/i.test(lower)) permRisk += 0.3;
  permRisk = clamp01(permRisk);

  let libRep = 0.65;
  if (/vulnerable[_-]?pkg[_-]?2023/.test(lower)) libRep = Math.min(libRep, 0.1);

  let bigO: BigOClass = "unknown";
  if (loopDepthApprox >= 3) bigO = "O(n^3)";
  else if (loopDepthApprox === 2) bigO = "O(n^2)";
  else if (sortHint || divideAndConquerHint) bigO = "O(n log n)";
  else if (loopDepthApprox === 1 || recursion) bigO = "O(n)";
  else bigO = "unknown";

  // SD: 정규식 기반 + 벡터 기반 CVE 위험도 결합 → cveSeverity01
  const regexRules = regexHeuristicScoreFromDB(code, RULE_DB);
  const vectorRules = vectorCveScan(code);
  const cveSeverity01 = clamp01(1 - (1 - regexRules.severity01) * (1 - vectorRules.aggregatedSeverity01));

  if (regexRules.matches.length) {
    reasons.push(...regexRules.matches.map((m) => `regex:${m.id} sev=${m.severity01.toFixed(2)}`));
  }
  if (vectorRules.matches.length) {
    reasons.push(...vectorRules.matches.map((m) => `vector:${m.id} sim=${m.similarity.toFixed(2)} sev=${m.severity01.toFixed(2)}`));
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
    memAllocs: bufAlloc.length + arrAlloc.length + arrayLits.length + objectLits.length + mapSet,
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

// 전체 정적 파이프라인을 실행해 StaticMetrics를 구성하는 메인 함수
//  - SF: coreTouched, schemaChanged, (fallback 시) apiChanges/diffChangedLines, semanticF
//  - SR: preciseResourceAndSecurityScan의 bigO, cc, mem, externalCalls, ioCalls
//  - SD: preciseResourceAndSecurityScan의 cveSeverity01, libReputation01, permRisk01 등
async function runStaticPipeline(code: string, filename: string | null | undefined, _language: string): Promise<StaticMetrics> {
  const lineCount = (code.match(/\n/g) || []).length + 1;

  const totalApis = Math.max(1, (code.match(/\bexport\s+(function|class|interface|type|const|let|var)\b/g) || []).length || 5);
  const coreTouched = !!filename && /(\/|^)(core|service|domain)\//i.test(filename);
  const diffChangedLines = Math.min(200, Math.round(lineCount * 0.2));
  const schemaChanged = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|MIGRATION)\b/i.test(code);

  const pr = preciseResourceAndSecurityScan(code);

  const metrics: StaticMetrics = {
    apiChanges: 0,
    totalApis,
    coreTouched,
    diffChangedLines,
    totalLines: Math.max(1, lineCount),
    schemaChanged,

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

    cveSeverity01: pr.cveSeverity01,
    libReputation01: pr.libReputation01,
    licenseMismatch: pr.licenseMismatch,
    permRisk01: pr.permRisk01,

    _reasons: pr._reasons
  };

  try {
    // SF: AST/호출 그래프 기반 Functionality 영향도(semanticF)를 계산해 StaticMetrics에 포함
    const sem = computeFSignalsSemantic(code, _language);
    if (sem) {
      metrics.semanticF = {
        score: sem.score,
        impactedEntrypointRatio: sem.details.impactedEntrypointRatio ?? 0,
        reachableNodesRatio: sem.details.reachableNodesRatio ?? 0,
        centralityScore: sem.details.centralityScore ?? 0
      };
    }
  } catch {
  }

  return metrics;
}

// FRD 각각의 내부 세부 신호에 대한 가중치 설정
//  - WF: SF(Functionality) 내부 신호(api/core/diff/schema) 비중 (semanticF 사용 시는 우선순위 낮음)
//  - WR: SR(Resource) 내부 신호(Big-O, CC, 메모리, 외부/IO 호출) 비중
//  - WD: SD(Dependency) 내부 신호(CVE, 평판, 라이선스, 권한) 비중
const WF = { api: 0.40, core: 0.25, diff: 0.20, schema: 0.15 };
const WR = { bigO: 0.32, cc: 0.18, mem: 0.22, ext: 0.18, io: 0.10 };
const WD = { cve: 0.42, rep: 0.25, lic: 0.10, perm: 0.23 };

// StaticMetrics에서 F(Functionality) 차원 점수를 계산하는 함수
//  → SF: semanticF.score(호출 그래프 기반)가 있으면 그것만 사용
//       없으면 apiRatio, coreTouched, diffRatio, schemaChanged를 조합해 SF 산출
function computeFSignalsFromMetrics(m: StaticMetrics) {
  if (m.semanticF) {
    const semanticOnly = m.semanticF.score;
    return clamp01(semanticOnly);
  }

  const apiRatio = clamp01(m.apiChanges / Math.max(1, m.totalApis));
  const diffRatio = clamp01(m.diffChangedLines / Math.max(1, m.totalLines));
  const v = apiRatio * WF.api + (m.coreTouched ? 1 : 0) * WF.core + diffRatio * WF.diff + (m.schemaChanged ? 1 : 0) * WF.schema;
  return clamp01(v);
}

// StaticMetrics에서 R(Resource) 차원 점수를 계산하는 함수
//  → SR: 시간 복잡도(Big-O), CC, 메모리, 외부/IO 호출을 통합해 하나의 R 값으로 변환
function computeRSignalsFromMetrics(m: StaticMetrics) {
  const bigO = mapBigOTo01(m.bigO);
  const ccNorm = clamp01(1 - Math.exp(-0.12 * Math.max(0, m.cc - 1)));
  const memByteNorm = clamp01(Math.log2(Math.max(1, m.memBytesApprox)) / 24);
  const memAllocNorm = clamp01(1 - Math.exp(-0.06 * m.memAllocs));
  const mem = clamp01(0.7 * memByteNorm + 0.3 * memAllocNorm);
  const ext = clamp01(1 - Math.exp(-0.05 * m.externalCalls));
  const io = clamp01(1 - Math.exp(-0.06 * m.ioCalls));
  const v = bigO * WR.bigO + ccNorm * WR.cc + mem * WR.mem + ext * WR.ext + io * WR.io;
  return clamp01(v);
}

// StaticMetrics에서 D(Dependency) 차원 점수를 계산하는 함수
//  → SD: CVE 위험도, 라이브러리 평판 역치, 라이선스 위배, 권한 위험을 통합해 D 값으로 변환
function computeDSignalsFromMetrics(m: StaticMetrics) {
  const v = m.cveSeverity01 * WD.cve + (1 - m.libReputation01) * WD.rep + (m.licenseMismatch ? 1 : 0) * WD.lic + m.permRisk01 * WD.perm;
  return clamp01(v);
}

// StaticMetrics를 FRD 벡터와 UI에 보여줄 신호 테이블로 변환하는 함수
//  - vector: [SF, SR, SD]
//  - signalTable.F/R/D: 각 차원의 내부 세부 신호들
function analyzeFromStaticMetrics(metrics: StaticMetrics, filename?: string | null) {
  const F = computeFSignalsFromMetrics(metrics); // SF
  const R = computeRSignalsFromMetrics(metrics); // SR
  const D = computeDSignalsFromMetrics(metrics); // SD

  const vector: [number, number, number] = [F, R, D];

  const signalTable = {
    F: {
      apiRatio: clamp01(metrics.apiChanges / Math.max(1, metrics.totalApis)),
      coreModuleModified: metrics.coreTouched ? 1 : 0,
      diffLineRatio: clamp01(metrics.diffChangedLines / Math.max(1, metrics.totalLines)),
      schemaChanged: metrics.schemaChanged ? 1 : 0,
      semanticScore: metrics.semanticF?.score ?? 0,
      influencedEntrypoints: metrics.semanticF?.impactedEntrypointRatio ?? 0,
      reachability: metrics.semanticF?.reachableNodesRatio ?? 0,
      centrality: metrics.semanticF?.centralityScore ?? 0
    },
    R: {
      timeComplexity: mapBigOTo01(metrics.bigO),
      cyclomaticComplexity: metrics.cc,
      loopDepthApprox: metrics.loopDepthApprox,
      memBytesApprox: metrics.memBytesApprox,
      memNorm: clamp01(0.7 * (Math.log2(Math.max(1, metrics.memBytesApprox)) / 24) + 0.3 * (1 - Math.exp(-0.06 * metrics.memAllocs))),
      externalCallNorm: clamp01(1 - Math.exp(-0.05 * metrics.externalCalls)),
      ioCallNorm: clamp01(1 - Math.exp(-0.06 * metrics.ioCalls))
    },
    D: {
      cveSeverity: metrics.cveSeverity01,
      libReputation: metrics.libReputation01,
      licenseMismatch: metrics.licenseMismatch ? 1 : 0,
      sensitivePerm: metrics.permRisk01
    }
  };

  return { vector, filename, signalTable, reasons: metrics._reasons };
}

// FRD 벡터를 최종 CRAI 점수 및 심각도로 변환하는 함수
//  - 입력: v = [SF, SR, SD]
//  - 출력: CRAI score(0~10), severity(red/orange/yellow/green), level 등
function scoreFromVector(v: number[], top?: { wF: number; wR: number; wD: number }) {
  const cfg = top ?? { wF: 0.40, wR: 0.30, wD: 0.30 };

  const SF = clamp01(v[0]); // Functionality
  const SR = clamp01(v[1]); // Resource
  const SD = clamp01(v[2]); // Dependency

  // B: 단순 가중 합 기반 CRAI 후보 (SF/SR/SD의 선형 결합)
  const B = 10 * (cfg.wF * SF + cfg.wR * SR + cfg.wD * SD);

  // C: SD를 우선시하되, SD가 낮을 때는 SF/SR 영향도도 함께 고려하는 대체 스코어
  const wrSum = cfg.wF + cfg.wR;
  const mixFR = wrSum > 0 ? (cfg.wF / wrSum) * SF + (cfg.wR / wrSum) * SR : 0;
  const C = Math.min(10, 10 * (SD + (1 - SD) * mixFR));

  // rho: FRD 중 SD 비중, s: SD가 어느 정도 이상일 때부터 C를 강조하는 smoothstep
  const rho = SD / (SF + SR + SD + 1e-6);
  const s = smoothstep(SD, 0.4, 0.7);
  const alpha = s * (0.5 + 0.5 * rho);

  // 최종 CRAI: B와 C를 SD 중심 가중치(alpha)로 혼합
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
    score,
    severity,
    level,
    action,
    weights: cfg,
    crai_components: { B, C, alpha, rho, s, SF, SR, SD, mixFR }
  };
}

// CRAI에서 사용하는 부드러운 구간 전이(smoothstep) 함수
//  → SD가 특정 구간(0.4~0.7)을 넘을 때 C에 대한 비중(alpha)을 점진적으로 키우기 위해 사용
function smoothstep(x: number, a: number, b: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

// Ollama 응답 문자열에서 파일명 힌트를 추출하는 함수
//  → FRD와 직접적 연관은 없고, 승인 후 파일 저장 UX 개선용
function detectSuggestedFileName(fullText: string, _fallbackLang?: string | null): string | null {
  const re =
    /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*)([A-Za-z0-9_\-./]+?\.[A-Za-z]{1,8})/gi;
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

// 텍스트에서 마지막 코드블록 하나만 추출하는 (레거시) 함수
//  → SF/SR/SD 분석 대상 코드를 뽑아내는 초기 버전 (현재는 extractCodeBlocksTS 사용)
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

// 텍스트에서 모든 ``` 코드블록을 추출해 Snippet 배열로 반환하는 함수
//  → SF/SR/SD 분석 대상이 되는 여러 코드블록을 추출하는 현재 버전
function extractCodeBlocksTS(text: string): Snippet[] {
  const blocks: Snippet[] = [];
  const regex = /```([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const body = match[1] ?? "";
    const nl = body.indexOf("\n");
    if (nl > -1) {
      const maybeLang = body.slice(0, nl).trim();
      const code = body.slice(nl + 1);
      const language = /^[a-zA-Z0-9+#._-]{0,20}$/.test(maybeLang) && maybeLang ? maybeLang : "plaintext";
      blocks.push({ language, code, suggested: detectSuggestedFileName(code, language) });
    } else {
      blocks.push({ language: "plaintext", code: body, suggested: null });
    }
  }
  return blocks;
}

// 단일 코드 스니펫 승인 후 파일/터미널에 반영하는 로직
//  → FRD(CRAI) 결과를 사용자가 신뢰할 수 있을 때만 실제 시스템에 반영하는 Human-in-the-loop 부분
async function handleApproval(code: string, language: string, suggested?: string | null) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
    return;
  }

  const shellCmdPattern =
    /^(npm|yarn|pip|pip3|pnpm|apt|apt-get|brew|git|chmod|chown|sudo|rm|mv|cp|mkdir|rmdir|systemctl|service|curl|bash)\b/i;
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
    if (denylist.some((rx) => rx.test(code))) {
      vscode.window.showErrorMessage("위험 명령이 감지되어 실행을 차단했습니다.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "터미널 명령으로 감지되었습니다. 통합 터미널에서 실행할까요?",
      { modal: true },
      "실행",
      "취소"
    );
    if (confirm !== "실행") return;

    const termName = "AI Approval Agent";
    let terminal = vscode.window.terminals.find((t) => t.name === termName);
    if (!terminal) terminal = vscode.window.createTerminal({ name: termName });
    terminal.show(true);

    const lines = code.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const line of lines) terminal.sendText(line, true);
    vscode.window.showInformationMessage(`터미널에서 ${lines.length}개 명령을 실행했습니다.`);
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: "Overwrite current file", description: "활성 에디터의 전체 내용을 교체" },
      { label: "Insert at cursor", description: "활성 에디터의 현재 커서 위치에 삽입" },
      { label: "Save as new file", description: "새 파일로 저장 (현재 동작)" }
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

  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(code));
  vscode.window.showInformationMessage(`승인됨 → ${targetRel} 저장 완료`);

  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
}

// 여러 코드 스니펫을 한 번에 승인/저장하는 로직
//  → 여러 SF/SR/SD 분석 결과를 한 번에 반영할 때 사용하는 UX 레이어
async function handleApprovalMany(snippets: Snippet[]) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
    return;
  }
  if (!snippets.length) return;

  const choice = await vscode.window.showQuickPick(
    [
      { label: "Save each as new file", description: "각 블록을 개별 새 파일로 저장" },
      { label: "Insert concatenated", description: "활성 에디터 커서 위치에 모두 이어붙여 삽입" },
      { label: "Create folder & save", description: "하위 폴더를 만들고 파일별로 저장" }
    ],
    { placeHolder: "여러 코드블록을 어떻게 적용할까요?" }
  );
  if (!choice) return;

  const root = vscode.workspace.workspaceFolders[0].uri;

  if (choice.label === "Insert concatenated") {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("활성 에디터가 없습니다.");
      return;
    }
    const joined = snippets.map((s) => s.code).join("\n\n");
    await editor.edit((eb) => eb.insert(editor.selection.active, joined));
    vscode.window.showInformationMessage(`총 ${snippets.length}개 블록을 현재 문서에 삽입했습니다.`);
    return;
  }

  if (choice.label === "Save each as new file") {
    for (const s of snippets) {
      const ext = guessExtension(s.language);
      const targetRel = sanitizeRelativePath(s.suggested) || (await nextAutoName(root, ext));
      await ensureParentDir(root, targetRel);
      const fileUri = vscode.Uri.joinPath(root, targetRel);
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(s.code));
    }
    vscode.window.showInformationMessage(`총 ${snippets.length}개 블록을 개별 파일로 저장했습니다.`);
    return;
  }

  if (choice.label === "Create folder & save") {
    const folderName = `generated_${Date.now()}`;
    const folderUri = vscode.Uri.joinPath(root, folderName);
    await vscode.workspace.fs.createDirectory(folderUri);

    for (let i = 0; i < snippets.length; i++) {
      const s = snippets[i];
      const ext = guessExtension(s.language);
      const base =
        s.suggested && sanitizeRelativePath(s.suggested)
          ? sanitizeRelativePath(s.suggested)!
          : `snippet_${String(i + 1).padStart(2, "0")}.${ext}`;
      const rel = base.includes("/") ? base.split("/").pop()! : base;
      const fileUri = vscode.Uri.joinPath(folderUri, rel);
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(s.code));
    }
    vscode.window.showInformationMessage(`폴더 ${folderName} 아래에 ${snippets.length}개 파일을 저장했습니다.`);
    return;
  }
}

// 활성 에디터 전체 내용을 생성된 코드로 덮어쓰는 함수 (FRD/CRAI 검증 후 실제 코드 반영 경로 중 하나)
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

// 현재 커서 위치에 코드를 삽입하는 함수 (FRD/CRAI 검증 후 반영 옵션)
async function insertAtCursor(code: string): Promise<vscode.Uri | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("활성 에디터가 없습니다.");
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

// 언어 이름을 기반으로 파일 확장자를 추정하는 함수 (승인 UX용)
function guessExtension(language: string): string {
  const map: Record<string, string> = {
    javascript: "js",
    typescript: "ts",
    python: "py",
    html: "html",
    css: "css",
    java: "java",
    c: "c",
    cpp: "cpp",
    tsx: "tsx",
    jsx: "jsx",
    json: "json",
    plaintext: "txt",
    bash: "sh",
    sh: "sh",
    kotlin: "kt"
  };
  const key = (language || "").toLowerCase().trim();
  return map[key] || (key.match(/^[a-z0-9]+$/) ? key : "txt");
}

// 상대 경로에서 보안상 위험한 요소를 제거하는 함수 (파일 시스템 보호)
function sanitizeRelativePath(p?: string | null): string | null {
  if (!p) return null;
  if (p.includes("..")) return null;
  return p.replace(/^\/+/, "").trim();
}

// 자동 파일 이름을 생성하는 함수 (중복 방지, 승인 UX용)
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

// 파일 저장을 위해 상위 디렉터리를 먼저 생성하는 함수 (파일 I/O 유틸)
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

// Webview HTML 템플릿을 구성하는 함수 (UI 레이아웃 정의)
//  → SF/SR/SD 값과 CRAI 점수를 사용자에게 시각적으로 보여주는 컨테이너 (실제 계산은 extension.ts)
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

// CSP nonce 생성을 위한 랜덤 문자열 생성 함수 (보안용)
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// VS Code 확장 비활성화 시 호출되는 훅 (정리용)
export function deactivate() {}