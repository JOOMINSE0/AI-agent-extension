// src/extension.ts
import * as vscode from "vscode";

/**
 * AI Approval Agent (CRAI 식 적용 + 정적 분석 기반 SF/SR/SD 산출)
 * - 코드 생성(스트리밍)은 유지(옵션) — 점수 계산에는 관여하지 않음
 * - 정적 파이프라인 결과(StaticMetrics) → SF/SR/SD 스코어링 → CRAI 식(2)
 * - 승인 게이트: 위험 명령 차단, RED 확인문자 입력
 * - 승인 시 적용 위치 선택: 현재 파일 덮어쓰기 / 커서에 삽입 / 새 파일 저장
 */

export function activate(context: vscode.ExtensionContext) {
  console.log("AI Approval Agent is now active!");

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
              prompt: `고위험(${score})입니다. 계속하려면 'CONFIRM'을 입력하세요.`,
              validateInput: v => (v === "CONFIRM" ? null : "CONFIRM 을 입력해야 합니다.")
            });
            if (input !== "CONFIRM") return;
          }

          await handleApproval(code, language, filename);
          break;
        }

        case "reject": {
          vscode.window.showWarningMessage("거절되었습니다(저장/실행 안 함)");
          break;
        }

        case "details": {
          vscode.window.showInformationMessage("자세히 보기: 사유는 카드에 표시됩니다.");
          break;
        }

        case "ask": {
          const { endpoint, model, wF, wR, wD } = getCfg();
          try {
            // 1) (옵션) 코드 생성 스트리밍 — 점수와 무관, UI 제공용
            const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
              webview.postMessage({ type: "delta", text: delta });
            });

            // 2) 사용자 프롬프트 포함 조합 (UI용 텍스트)
            const combined = `USER:\n${msg.text}\n\nASSISTANT:\n${fullText}`;

            // 3) 코드블록 추출 + 파일명 힌트
            const snippet = extractLastCodeBlockTS(fullText);
            const code = snippet?.code ?? "";
            const language = snippet?.language ?? "plaintext";
            const suggested = detectSuggestedFileName(fullText, language);

            // 4) 정적 파이프라인 실행 → StaticMetrics
            const metrics = await runStaticPipeline(code, suggested, language);

            // 5) 정적 분석 결과 → 신호(F/R/D) → 차원 점수
            const heur = analyzeFromStaticMetrics(metrics, suggested);

            // 6) 최종 CRAI (식 2) 계산 — 0.0~10.0 스케일
            const fusedVector = heur.vector; // ★ LLM 융합 없음
            const scored = scoreFromVector(fusedVector, { wF, wR, wD });

            // 7) 웹뷰로 전달 (CRAI 구성요소/신호 테이블 포함)
            webview.postMessage({
              type: "analysis",
              vector: fusedVector,
              score: scored.score,            // 0.0~10.0
              severity: scored.severity,      // green/yellow/orange/red
              level: scored.level,
              weights: scored.weights,
              suggestedFilename: suggested || null,
              language,
              code,
              reasons: {},                    
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

/* ---------- 정적 파이프라인: 메트릭 타입 ---------- */
type BigOClass = "O(1)"|"O(log n)"|"O(n)"|"O(n log n)"|"O(n^2)"|"O(n^3)"|"unknown";

type StaticMetrics = {
  // SF
  apiChanges: number;      // 변경된 공개 API 시그니처 수
  totalApis: number;       // 전체 공개 API 수(변경 전 기준)
  coreTouched: boolean;    // core/domain/service 경로 변경 여부
  diffChangedLines: number;// 변경 라인 수
  totalLines: number;      // 파일 총 라인 수(변경 기준 파일들 합)
  schemaChanged: boolean;  // DB 스키마 변경(마이그레이션/DDL)

  // SR
  bigO: BigOClass;         // 추정 시간 복잡도 등급
  memAllocs: number;       // 메모리 할당 관련 구문 수(new/Buffer/Array 등)
  externalCalls: number;   // 외부 호출(fetch/db/redis/http 등) 수

  // SD
  cveSeverity01: number;   // 0..1 (CVSS 정규화)
  libReputation01: number; // 0..1 (높을수록 안전)
  licenseMismatch: boolean;// 라이선스 충돌 여부
  permRisk01: number;      // 권한/자격 위험(0..1)
};

/* ---------- 정적 파이프라인 실행 (스텁: 실제 도구로 대체하세요) ---------- */
async function runStaticPipeline(code: string, filename: string|null|undefined, language: string): Promise<StaticMetrics> {
  // TODO: 여기를 실제 분석기로 교체
  // - Git diff/AST: ts-morph, tree-sitter, babel parser 등
  // - SCA: osv-scanner/Dependency-Check 결과 파싱
  // - 빌드 아티팩트/메타데이터 결합
  // 지금은 안전한 기본값 + 간단한 스케일러만 제공
  const lineCount = (code.match(/\n/g) || []).length + 1;

  const metrics: StaticMetrics = {
    apiChanges: 0,
    totalApis:  Math.max(1, (code.match(/\bexport\s+(function|class|interface)\b/g) || []).length || 5),
    coreTouched: !!filename && /(\/|^)(core|service|domain)\//i.test(filename),
    diffChangedLines: Math.min(200, Math.round(lineCount*0.2)),
    totalLines: Math.max(1, lineCount),
    schemaChanged: /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|MIGRATION)\b/i.test(code),

    bigO: "unknown",
    memAllocs: (code.match(/\bnew\s+[A-Z][A-Za-z0-9_]*\b/g) || []).length
             + (code.match(/\bBuffer\.alloc|new\s+Array\b/gi) || []).length,
    externalCalls: (code.match(/\b(fetch|axios|request|http\.|https\.|db\.|query|sequelize|prisma|jdbc|mongo|redis)\b/gi) || []).length,

    cveSeverity01: 0.0,
    libReputation01: 0.65,
    licenseMismatch: false,
    permRisk01: (/\bfs\.(read|write|unlink|chmod|chown|readdir)\b/i.test(code) ? 0.3 : 0)
              + (/\bprocess\.env\b|\bcredential|\bpassword\b/i.test(code) ? 0.3 : 0)
              + (/\bchild_process|exec\(|spawn\(|popen\(|system\(/i.test(code) ? 0.4 : 0)
  };

  // 간단 Big-O 근사
  if (/\bfor\s*\(.*\)\s*{[^}]*for\s*\(/is.test(code) || /\bwhile\s*\(.*\)\s*{[^}]*while\s*\(/is.test(code)) {
    metrics.bigO = "O(n^2)";
  } else if (/\bfor\s*\(/.test(code) || /\bwhile\s*\(/.test(code)) {
    metrics.bigO = "O(n)";
  } else {
    metrics.bigO = "unknown";
  }

  metrics.permRisk01 = clamp01(metrics.permRisk01);
  metrics.cveSeverity01 = clamp01(metrics.cveSeverity01);
  metrics.libReputation01 = clamp01(metrics.libReputation01);

  return metrics;
}

/* ---------- Weights (신호/차원) ---------- */
const WF = { api: 0.40, core: 0.25, diff: 0.20, schema: 0.15 };
const WR = { bigO: 0.40, mem: 0.30, ext: 0.20 };
const WD = { cve: 0.35, rep: 0.30, lic: 0.20, perm: 0.15 };

const clamp01 = (x:number)=> Math.max(0, Math.min(1, x));

function mapBigOTo01(bigO: BigOClass){
  const lut:{[k in BigOClass]:number} = {
    "O(1)":0.05, "O(log n)":0.15, "O(n)":0.20, "O(n log n)":0.35, "O(n^2)":0.70, "O(n^3)":0.90, "unknown":0.50
  }; return lut[bigO] ?? 0.50;
}
const sat01 = (x:number, k:number)=> clamp01(1 - Math.exp(-k * Math.max(0,x))); // 포화형 스케일러

/* ---- 차원 점수 계산 (정적 메트릭 기반) ---- */
function computeFSignalsFromMetrics(m: StaticMetrics) {
  const apiRatio  = clamp01(m.apiChanges / Math.max(1, m.totalApis));
  const diffRatio = clamp01(m.diffChangedLines / Math.max(1, m.totalLines));
  const v = apiRatio*WF.api + (m.coreTouched?1:0)*WF.core + diffRatio*WF.diff + (m.schemaChanged?1:0)*WF.schema;
  return clamp01(v);
}
function computeRSignalsFromMetrics(m: StaticMetrics) {
  const bigO = mapBigOTo01(m.bigO);
  const mem  = clamp01(sat01(m.memAllocs, 0.06));     // ~50개에서 0.95 접근
  const ext  = clamp01(sat01(m.externalCalls, 0.05)); // ~40개에서 0.86
  const v = bigO*WR.bigO + mem*WR.mem + ext*WR.ext;
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

  // 웹뷰용 신호 테이블
  const signalTable = {
    F: { apiRatio: clamp01(metrics.apiChanges / Math.max(1, metrics.totalApis)),
         coreModuleModified: metrics.coreTouched ? 1 : 0,
         diffLineRatio: clamp01(metrics.diffChangedLines / Math.max(1, metrics.totalLines)),
         schemaChanged: metrics.schemaChanged ? 1 : 0 },
    R: { timeComplexity: mapBigOTo01(metrics.bigO),
         memIncreaseNorm: clamp01(sat01(metrics.memAllocs, 0.06)),
         externalCallNorm: clamp01(sat01(metrics.externalCalls, 0.05)) },
    D: { cveSeverity: metrics.cveSeverity01,
         libReputation: metrics.libReputation01,
         licenseMismatch: metrics.licenseMismatch ? 1 : 0,
         sensitivePerm: metrics.permRisk01 }
  };

  return { vector, filename, signalTable };
}

/* ---------- Final scoring: CRAI 식(2) 적용 (0.0~10.0) ---------- */
/**
 * CRAI = min(10, (1-α)B + αC)
 *  B = 10 (wF*SF + wR*SR + wD*SD)
 *  C = min(10, 10 [ SD + (1-SD) ( (wF/(wF+wR))SF + (wR/(wF+wR))SR ) ])
 *  ρ = SD / (SF + SR + SD + 1e-6)
 *  α = s(SD; 0.4, 0.7) * (0.5 + 0.5ρ)
 *  s(x;a,b) = 0 (x≤a), 1 (x≥b), 그 사이는 smoothstep: t^2(3-2t), t=(x-a)/(b-a)
 */
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

/* ----- smoothstep 스무딩 함수 (s(x; a, b)) ----- */
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
 *  승인 후 코드 적용: (1) 현재 파일 덮어쓰기 (2) 커서에 삽입 (3) 새 파일로 저장
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

    #composer #prompt::placeholder {
      color: #888;
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
        무엇을 도와드릴까요? “코드 생성” 요청을 하면, 생성된 코드에 대해 승인/거절을 선택할 수 있어요.
      </div>
    </div>
    <form id="composer">
      <input id="prompt" type="text" placeholder="예) express 서버 초기 코드 만들어줘" />
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

/* ----------------------------------------------------------------------
 * 참고: package.json의 contributes.configuration에 아래 키를 등록하면
 * 가중치/모델 엔드포인트를 UI에서 조절할 수 있어요.
 *
"contributes": {
  "configuration": {
    "title": "AI Approval Agent",
    "properties": {
      "aiApproval.ollama.endpoint": { "type":"string", "default":"http://210.110.103.64:11434" },
      "aiApproval.ollama.model":    { "type":"string", "default":"llama3.1:8b" },
      "aiApproval.weights.functionality": { "type":"number", "default":0.40, "minimum":0, "maximum":1 },
      "aiApproval.weights.resource":      { "type":"number", "default":0.30, "minimum":0, "maximum":1 },
      "aiApproval.weights.dependency":    { "type":"number", "default":0.30, "minimum":0, "maximum":1 }
    }
  }
}
 * -------------------------------------------------------------------- */
