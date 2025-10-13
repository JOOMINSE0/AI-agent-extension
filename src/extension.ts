// src/extension.ts
import * as vscode from "vscode";

/**
 * AI Approval Agent (FRD 2단 가중치 반영판)
 * - Ollama 스트리밍
 * - 휴리스틱 + LLM 자가평가(JSON: function_change/resource_usage/security_dependency) 융합
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
    endpoint: (cfg.get<string>("aiApproval.ollama.endpoint") || "http://210.110.103.64:11434").replace(/\/$/, ""),
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3.1:8b",
    // 최상위 FRD 가중치 (합 1 권장)
    wF: cfg.get<number>("aiApproval.weights.functionality") ?? 0.40,
    wR: cfg.get<number>("aiApproval.weights.resource") ?? 0.30,
    wD: cfg.get<number>("aiApproval.weights.dependency") ?? 0.30,
    // 휴리스틱 vs LLM 융합 비율
    alpha: cfg.get<number>("aiApproval.fusion.alpha") ?? 0.60
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
          vscode.window.showWarningMessage("거절되었습니다 ❌ (저장/실행 안 함)");
          break;
        }

        case "details": {
          vscode.window.showInformationMessage("자세히 보기: 사유는 카드에 표시됩니다.");
          break;
        }

        case "ask": {
          const { endpoint, model, wF, wR, wD, alpha } = getCfg();
          try {
            // 1) 스트리밍 + 전체 텍스트 수집
            const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
              webview.postMessage({ type: "delta", text: delta });
            });

            // 2) 사용자 프롬프트 포함 조합 (위험 의도 반영)
            const combined = `USER:\n${msg.text}\n\nASSISTANT:\n${fullText}`;

            // 3) 코드블록 추출 + 파일명 힌트
            const snippet = extractLastCodeBlockTS(fullText);
            const suggested = detectSuggestedFileName(fullText, snippet?.language ?? "plaintext");

            // 4) 휴리스틱 → 신호(F/R/D) → 차원 점수
            const heur = analyzeGeneratedText(combined, snippet?.code ?? "", suggested);

            // 5) LLM 자가평가(JSON) — 키 이름 스펙 일치
            const llm = await llmSelfJudgeJSON(endpoint, model, combined, snippet?.code ?? "");

            // 6) 융합 (휴리스틱 60% + LLM 40% 기본)
            const fusedVector = fuseVector(
              heur.vector,
              llm ? [llm.function_change, llm.resource_usage, llm.security_dependency] : null,
              alpha
            );

            // 7) 최종 점수 (상위 가중치 적용) — 0.0~10.0 스케일
            const scored = scoreFromVector(fusedVector, { wF, wR, wD });

            // 참고치(설명력)
            const llmVector = llm ? [llm.function_change, llm.resource_usage, llm.security_dependency] : heur.vector;
            const llmOnly = scoreFromVector(llmVector, { wF, wR, wD });
            const heurOnly = scoreFromVector(heur.vector, { wF, wR, wD });

            // 8) 웹뷰로 전달 (신호 테이블 + 사유 포함)
            webview.postMessage({
              type: "analysis",
              vector: fusedVector,
              score: scored.score,            // 0.0~10.0
              severity: scored.severity,      // green/yellow/orange/red
              weights: scored.weights,
              suggestedFilename: suggested || null,
              language: snippet?.language ?? "plaintext",
              code: snippet?.code ?? "",
              reasons: llm?.reasons || {},
              signalTable: heur.signalTable,  // 휴리스틱 추정 신호값
              breakdown: {
                fused:   { vector: fusedVector, ...scored },
                llmOnly: { vector: llmVector,   ...llmOnly },
                heurOnly:{ vector: heur.vector, ...heurOnly }
              }
            });

            webview.postMessage({ type: "done" });
          } catch (e: any) {
            const detail = e?.message || String(e);
            console.error("Ollama 호출 실패:", e);
            vscode.window.showErrorMessage(`Ollama 호출 실패: ${detail}`);
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
  if (!fetchFn) throw new Error("fetch가 지원되지 않는 런타임입니다.");

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

  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

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

/* ---------- LLM Self-Judge(JSON) ---------- */
type LlmJudge = {
  function_change: number;        // F
  resource_usage: number;         // R
  security_dependency: number;    // D
  reasons: Record<string, string>;
} | null;

async function llmSelfJudgeJSON(
  endpoint: string,
  model: string,
  fullText: string,
  code: string
): Promise<LlmJudge> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchFn: any = (globalThis as any).fetch;
  const res = await fetchFn(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content:
`You are a code change risk auditor. Return STRICT JSON only. No prose.
Keys and ranges:
{
 "function_change": 0..1,
 "resource_usage": 0..1,
 "security_dependency": 0..1,
 "reasons": {
   "function_change": "short reason",
   "resource_usage": "short reason",
   "security_dependency": "short reason"
 }
}
Interpretation:
- function_change: public API ratio↑, core/domain change, large diff, schema change
- resource_usage: heavy loops/parallelism, memory growth, external calls/cost
- security_dependency: new/vulnerable deps, dangerous APIs (eval/exec), credentials, SQL risks`
        },
        {
          role: "user",
          content:
`Analyze this assistant answer & code.

# ASSISTANT_TEXT
${fullText}

# CODE
\`\`\`
${code}
\`\`\`

Return JSON ONLY.`
        }
      ]
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.message?.content?.trim?.() ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ---------- Weights (신호/차원) ---------- */
// 차원 내부 신호 가중치 (합 1)
const WF = { api: 0.40, core: 0.25, diff: 0.20, schema: 0.15 };
const WR = { bigO: 0.40, mem: 0.30, ext: 0.20 };
const WD = { cve: 0.35, rep: 0.30, lic: 0.20, perm: 0.15 };

const clamp01 = (x:number)=> Math.max(0, Math.min(1, x));

function mapBigOTo01(bigO: "O(1)"|"O(log n)"|"O(n)"|"O(n log n)"|"O(n^2)"|"O(n^3)"|"unknown"){
  const lut:{[k:string]:number} = {
    "O(1)":0.05, "O(log n)":0.15, "O(n)":0.20, "O(n log n)":0.35, "O(n^2)":0.70, "O(n^3)":0.90, "unknown":0.50
  }; return lut[bigO] ?? 0.50;
}

/* ---- 차원 점수 계산 ---- */
function computeFSignals(s:{ api:number, core:boolean, diff:number, schema:boolean }) {
  const v = s.api*WF.api + (s.core?1:0)*WF.core + s.diff*WF.diff + (s.schema?1:0)*WF.schema;
  return clamp01(v);
}
function computeRSignals(s:{ bigO:number, mem:number, ext:number }) {
  const v = s.bigO*WR.bigO + s.mem*WR.mem + s.ext*WR.ext;
  return clamp01(v);
}
function computeDSignals(s:{ cve:number, rep:number, lic:boolean, perm:number }) {
  const v = s.cve*WD.cve + (1 - s.rep)*WD.rep + (s.lic?1:0)*WD.lic + s.perm*WD.perm;
  return clamp01(v);
}

/* ---------- Heuristic analysis (신호 추정 + 차원 점수) ---------- */
function analyzeGeneratedText(fullText: string, code: string, filename?: string | null) {
  const whole = (fullText + "\n" + code);

  // ===== F 신호 추정 =====
  const apiChangedRatio = estimateChangedApiRatio(whole);        // 0..1
  const coreModule = isCoreModule(filename) || /(?:core|domain|service)\//i.test(whole);
  const diffRatio = estimateDiffLineRatio(whole);                 // 0..1 (간이)
  const schemaChanged = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+COLUMN|ADD\s+COLUMN|MIGRATION)\b/i.test(whole);
  const F = computeFSignals({ api: apiChangedRatio, core: coreModule, diff: diffRatio, schema: schemaChanged });

  // ===== R 신호 추정 =====
  const bigO = inferBigOFromText(whole);                          // 0..1
  const memInc = estimateMemIncrease(whole);                      // 0..1
  const extCalls = estimateExternalCallImpact(whole);             // 0..1
  const R = computeRSignals({ bigO, mem: memInc, ext: extCalls });

  // ===== D 신호 추정 =====
  const cveSeverity = /\bCVE-\d{4}-\d+\b/i.test(whole) ? 0.8 : 0.0; // 텍스트에 CVE 언급시 가중
  const libRep = estimateLibraryReputation(whole);                // 0..1 (높을수록 안전)
  const licenseMismatch = /LICENSE|SPDX|GPL\b.*\bMIT\b|license\s+conflict/i.test(whole) ? true : false;
  const sensitivePerm = estimateSensitivePermission(whole);       // 0..1
  const D = computeDSignals({ cve: cveSeverity, rep: libRep, lic: licenseMismatch, perm: sensitivePerm });

  const vector: [number, number, number] = [F, R, D];

  // 웹뷰용 신호 테이블(값만 전달)
  const signalTable = {
    F: { changedApiRatio: apiChangedRatio, coreModuleModified: coreModule ? 1 : 0, diffLineRatio: diffRatio, schemaChanged: schemaChanged ? 1 : 0 },
    R: { timeComplexity: bigO, memIncreaseRatio: memInc, externalCallNorm: extCalls },
    D: { cveSeverity, libReputation: libRep, licenseMismatch: licenseMismatch ? 1 : 0, sensitivePerm: sensitivePerm }
  };

  return { vector, code, filename, signalTable };
}

/* ---------- 간이 신호 추정 유틸 (AST/프로파일링 없이 텍스트/정규식으로 근사) ---------- */
function estimateChangedApiRatio(text:string): number {
  // export/public 함수 시그니처 변화를 간이 추정 (API 키워드 수의 변화 힌트)
  const addedApis = (text.match(/\bexport\s+(?:function|class|interface)\b/gi) || []).length
                  + (text.match(/\bpublic\s+(?:class|interface|function|method)\b/gi) || []).length;
  // 상수 10 기준으로 비율 근사 (실제 구현은 AST 비교 권장)
  return clamp01(addedApis / 10);
}
function estimateDiffLineRatio(text:string): number {
  // ```diff 혹은 +/− 라인 패턴 근사
  const plus = (text.match(/^\+\s?.+/gm) || []).length;
  const minus = (text.match(/^-\s?.+/gm) || []).length;
  const changed = plus + minus;
  return clamp01(changed / 500); // 500라인 기준 스케일
}
function inferBigOFromText(text:string): number {
  if (/\bfor\s*\(.*\)\s*{[^}]*for\s*\(/is.test(text) || /\bO\(n\^?2\)/i.test(text)) return mapBigOTo01("O(n^2)");
  if (/\bwhile\s*\(.*\)\s*{[^}]*while\s*\(/is.test(text)) return mapBigOTo01("O(n^2)");
  if (/\bfor\s*\(/i.test(text) && /\blog\b/i.test(text)) return mapBigOTo01("O(n log n)");
  if (/\bfor\s*\(/i.test(text) || /\bwhile\s*\(/i.test(text)) return mapBigOTo01("O(n)");
  return mapBigOTo01("unknown");
}
function estimateMemIncrease(text:string): number {
  const allocs = (text.match(/\bnew\s+[A-Z][A-Za-z0-9_]*\b/g) || []).length
               + (text.match(/\bmalloc|calloc|Array\(|Buffer\.alloc|new\s+Array\b/gi) || []).length;
  return clamp01(allocs / 50);
}
function estimateExternalCallImpact(text:string): number {
  const calls = (text.match(/\b(fetch|axios|request|http\.|https\.|db\.|query|sequelize|prisma|jdbc|mongo|redis)\b/gi) || []).length;
  return clamp01(calls / 40);
}
function estimateLibraryReputation(text:string): number {
  // 유명 프레임워크 키워드가 있으면 rep↑, 생소한 패키지 다량이면 rep↓ (아주 거친 근사)
  const wellKnown = /react|express|django|spring|numpy|pandas|lodash|fastapi|flask|typeorm|sequelize/i.test(text);
  const deps = Array.from(text.matchAll(/(?:import\s+([a-z0-9_.\-@/]+)|require\(['"]([a-z0-9_.\-@/]+)['"]\))/ig)).length;
  if (wellKnown && deps < 10) return 0.85;
  if (!wellKnown && deps >= 10) return 0.40;
  return 0.65;
}
function estimateSensitivePermission(text:string): number {
  let v = 0;
  if (/\bfs\.(read|write|unlink|chmod|chown|readdir)\b/i.test(text)) v += 0.3;
  if (/\bprocess\.env\b|\bcredential|\bpassword\b/i.test(text)) v += 0.3;
  if (/\bchild_process|exec\(|spawn\(|popen\(|system\(/i.test(text)) v += 0.4;
  return clamp01(v);
}
function isCoreModule(path?:string|null){
  if (!path) return false;
  return /(\/|^)(core|domain|service|app|server|main|index)\.[a-z0-9]+$/i.test(path)
      || /(\/|^)(core|domain|service)\//i.test(path);
}

/* ---------- Fuse Heuristic + LLM ---------- */
function fuseVector(
  heur: number[],                         // [F,R,D]
  llm: number[] | null,
  alpha: number
): number[] {
  if (!llm) return heur;
  return [
    alpha * heur[0] + (1 - alpha) * llm[0],
    alpha * heur[1] + (1 - alpha) * llm[1],
    alpha * heur[2] + (1 - alpha) * llm[2]
  ];
}

/* ---------- Final scoring (0.0~10.0) ---------- */
function scoreFromVector(v: number[], top?: { wF:number; wR:number; wD:number }) {
  const cfg = top ?? { wF:0.40, wR:0.30, wD:0.30 };
  const raw = v[0] * cfg.wF + v[1] * cfg.wR + v[2] * cfg.wD;  // 0..1
  const score = Math.round(raw * 10 * 10) / 10; // 소수 1자리 (예: 7.3)

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

  return { score, severity, level, action, weights: cfg };
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
  if (!/[A-Za-z]/.test(ext)) return null;      // 확장자에 영문 1자 이상
  if (/^\d+(\.\d+)+$/.test(last)) return null; // 순수 버전번호 문자열 제외
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

  // 터미널 명령 감지 + 위험 명령 차단
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

  // === 코드 적용 위치 선택 ===
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

  // --- 새 파일 저장 (기존 로직) ---
  const root = vscode.workspace.workspaceFolders[0].uri;
  const ext = guessExtension(language);
  const targetRel = sanitizeRelativePath(suggested) || (await nextAutoName(root, ext));

  await ensureParentDir(root, targetRel);
  const fileUri = vscode.Uri.joinPath(root, targetRel);

  const enc = new TextEncoder();
  await vscode.workspace.fs.writeFile(fileUri, enc.encode(code));
  vscode.window.showInformationMessage(`승인됨 ✅ → ${targetRel} 저장 완료`);

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
  await doc.save(); // 필요 시 자동 저장
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
  // 저장은 사용자가 직접 (Undo/Redo를 고려)
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
 * 가중치/융합 비율을 UI에서 조절할 수 있어요.
 *
"contributes": {
  "configuration": {
    "title": "AI Approval Agent",
    "properties": {
      "aiApproval.ollama.endpoint": { "type":"string", "default":"http://210.110.103.64:11434" },
      "aiApproval.ollama.model":    { "type":"string", "default":"llama3.1:8b" },
      "aiApproval.weights.functionality": { "type":"number", "default":0.40, "minimum":0, "maximum":1 },
      "aiApproval.weights.resource":      { "type":"number", "default":0.30, "minimum":0, "maximum":1 },
      "aiApproval.weights.dependency":    { "type":"number", "default":0.30, "minimum":0, "maximum":1 },
      "aiApproval.fusion.alpha":          { "type":"number", "default":0.60, "minimum":0, "maximum":1 }
    }
  }
}
 * -------------------------------------------------------------------- */
