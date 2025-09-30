import * as vscode from "vscode";

/**
 * AI Approval Agent
 * - Ollama 스트리밍
 * - 휴리스틱 + LLM 자가평가(JSON) 융합
 * - 승인: 코드 저장 또는 터미널 명령 실행
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
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3.1:8b"
  };
}

/* ---------- Webview messaging ---------- */
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "approve": {
          const { code = "", language = "plaintext", filename = null, score = null, severity = null } = msg || {};

          if (severity === "red") {
            const ok = await vscode.window.showWarningMessage(
              `이 변경은 높은 위험 점수(${score})입니다. 정말 저장/실행하시겠습니까?`,
              { modal: true },
              "확인",
              "취소"
            );
            if (ok !== "확인") return;
          }

          await handleApproval(code, language, filename);
          break;
        }

        case "reject": {
          vscode.window.showWarningMessage("거절되었습니다 ❌ (저장/실행 안 함)");
          break;
        }

        case "details": {
          vscode.window.showInformationMessage("자세히 보기: 사유는 카드에 표시됩니다. (확장 쪽 추가 액션 가능)");
          break;
        }

        case "ask": {
          const { endpoint, model } = getCfg();
          try {
            // 1) 스트리밍 + 전체 텍스트 수집
            const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
              webview.postMessage({ type: "delta", text: delta });
            });

            // 2) 사용자 프롬프트를 포함해서 분석(위험 의도 반영)
            const combined = `USER:\n${msg.text}\n\nASSISTANT:\n${fullText}`;

            // 3) 마지막 코드블록 추출 + 파일명 힌트
            const snippet = extractLastCodeBlockTS(fullText); // 코드블록은 답변에서 추출
            const suggested = detectSuggestedFileName(fullText, snippet?.language ?? "plaintext");

            // 4) 휴리스틱
            const heur = analyzeGeneratedText(combined, snippet?.code ?? "", suggested);

            // 5) LLM 자가평가(JSON)
            const llm = await llmSelfJudgeJSON(endpoint, model, combined, snippet?.code ?? "");

            // 6) 융합
            const fusedVector = fuseVector(heur.vector, llm);
            const scored = scoreFromVector(fusedVector);

            // 7) 웹뷰로 전달 (자가평가 사유 포함)
            webview.postMessage({
              type: "analysis",
              vector: fusedVector,
              score: scored.score,
              severity: scored.severity,
              suggestedFilename: suggested || null,
              language: snippet?.language ?? "plaintext",
              code: snippet?.code ?? "",
              reasons: llm?.reasons || {}
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
async function llmSelfJudgeJSON(
  endpoint: string,
  model: string,
  fullText: string,
  code: string
): Promise<{
  function_change: number;
  stability_risk: number;
  security_dependency: number;
  reasons: Record<string, string>;
} | null> {
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
 "stability_risk": 0..1,
 "security_dependency": 0..1,
 "reasons": {
   "function_change": "short reason",
   "stability_risk": "short reason",
   "security_dependency": "short reason"
 }
}
Interpretation:
- function_change: schema/core-purpose changes, main/server/index/core rewrite ↑
- stability_risk: infinite loops, heavy resources, fragile logic ↑
- security_dependency: new/vulnerable deps, eval/exec, credentials, SQL dangerous changes ↑`
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

/* ---------- Fuse Heuristic + LLM ---------- */
function fuseVector(
  heur: number[], // [F,R,S]
  llm?: { function_change: number; stability_risk: number; security_dependency: number } | null
): number[] {
  if (!llm) return heur;
  const v2 = [llm.function_change, llm.stability_risk, llm.security_dependency];
  const alpha = 0.6; // 휴리스틱 60% + LLM 40%
  return [
    alpha * heur[0] + (1 - alpha) * v2[0],
    alpha * heur[1] + (1 - alpha) * v2[1],
    alpha * heur[2] + (1 - alpha) * v2[2]
  ];
}

/* ---------- Heuristic analysis (강화판) ---------- */
function analyzeGeneratedText(fullText: string, code: string, filename?: string | null) {
  const whole = (fullText + "\n" + code);

  // F: 기능/목적 변경
  let F = 0;
  const funcKeywords = /\b(replace|rewrite|refactor|rework|rewrite core|change core|alter core|replace core)\b/i;
  if (funcKeywords.test(whole)) F += 0.6;
  if (filename && /(?:^|\/)(?:main|server|app|index|core)\.[a-z0-9]+$/i.test(filename)) F = Math.min(1, F + 0.3);
  if (code.length > 2000) F = Math.min(1, F + 0.2);

  // R: 안정성/자원
  let R = 0;
  const heavyPatterns = /\b(while\s*\(|for\s*\(|sleep\(|thread|fork|subprocess|multiprocessing|spawn|map_reduce|batch|malloc|calloc|new\s+[A-Z])/i;
  if (heavyPatterns.test(whole)) R += 0.4;
  if (code.split("\n").length > 200) R = Math.min(1, R + 0.2);

  // S: 보안/의존성 + SQL 보강
  let S = 0;
  const depMatches = Array.from(whole.matchAll(/(?:import\s+([a-z0-9_.\-]+)|require\(['"]([a-z0-9_.\-]+)['"]\))/ig));
  if (depMatches.length > 0) S += Math.min(0.6, 0.15 * depMatches.length);
  if (/\beval\(|exec\(|system\(|popen\(|open\([^,]*\/etc\/passwd|sshpass\b/i.test(whole)) S = Math.min(1, S + 0.6);

  // SQL/비밀번호 관련
  const hasSQLDDL        = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+COLUMN|ADD\s+COLUMN)\b/i.test(whole);
  const touchesUserTable = /\b(mysql\.user|users?\b|accounts?\b|credentials?\b)\b/i.test(whole);
  const addsPasswordCol  = /\bADD\s+COLUMN\s+`?password`?\b/i.test(whole);
  const updatesPassword  = /\bUPDATE\s+[^\s`]+(?:\s+SET|\s+SET\s+)+[^;]*\b`?password`?\b/i.test(whole);
  const mentionsPlain    = /\b(plain\s*text|평문)\b/i.test(whole) || /\bCHAR\s*\(|\bVARCHAR\s*\(|\bTEXT\b/i.test(whole);
  const usesHashing      = /\b(bcrypt|argon2|scrypt|pbkdf2|sha\d{1,3})\b/i.test(whole);
  const touchesSystemUsr = /\bmysql\.user\b/i.test(whole);

  if (hasSQLDDL && touchesUserTable) { F = Math.min(1, F + 0.5); S = Math.min(1, S + 0.3); }
  if (addsPasswordCol || updatesPassword) S = Math.min(1, S + 0.6);

  // "평문" 언급 + password 관련 작업 → 강하게 가중. (해시 포함 시 과도 상승 방지)
  if ((addsPasswordCol || updatesPassword || /password/i.test(whole)) && mentionsPlain && !usesHashing) {
    S = Math.min(1, S + 0.7);
    if (S < 0.6) S = 0.6; // 최소 바닥선
  }

  if (touchesSystemUsr) S = Math.min(1, S + 0.8);

  F = Math.min(1, Math.max(0, F));
  R = Math.min(1, Math.max(0, R));
  S = Math.min(1, Math.max(0, S));

  return { vector: [F, R, S], code, filename };
}

function scoreFromVector(v: number[]) {
  // 보안 비중을 더 주고 싶다면 [0.35, 0.30, 0.35]로 조정 가능
  const w = [0.30, 0.10, 0.60];
  const raw = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
  const score = Math.round(raw * 100);

  let severity: "green" | "yellow" | "red" = "green";
  if (score >= 70) severity = "red";
  else if (score >= 40) severity = "yellow";

  return { score, severity };
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

/* ---------- Approval: terminal-or-file ---------- */
async function handleApproval(code: string, language: string, suggested?: string | null) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
    return;
  }

  // 터미널 명령 감지
  const shellCmdPattern = /^(npm|yarn|pip|pip3|pnpm|apt|apt-get|brew|git|chmod|chown|sudo|rm|mv|cp|mkdir|rmdir|systemctl|service)\b/i;
  const firstLine = (code || "").trim().split(/\r?\n/)[0] || "";
  const looksLikeShell = language === "bash" || language === "sh" || shellCmdPattern.test(firstLine);

  if (looksLikeShell) {
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

  // 일반 코드 저장
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

/* ---------- Fs utils ---------- */
function guessExtension(language: string): string {
  const map: Record<string, string> = {
    javascript: "js", typescript: "ts", python: "py",
    html: "html", css: "css", java: "java",
    c: "c", cpp: "cpp", tsx: "tsx", jsx: "jsx",
    json: "json", plaintext: "txt", bash: "sh", sh: "sh"
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
  <title>AI Approval</title>
</head>
<body>
  <section class="chat">
    <div class="chat-header">AI Approval Agent</div>
    <div class="chat-body" id="chat">
      <div class="msg bot">무엇을 도와드릴까요? "코드 생성" 요청을 하면, 생성된 코드에 대해 승인/거절을 선택할 수 있어요.</div>
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
