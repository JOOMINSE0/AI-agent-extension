import * as vscode from "vscode";

/**
 * AI Approval Agent - extension.ts
 * - Ollama 스트리밍 호출
 * - 생성된 응답에 대해 분석(analyzeGeneratedText)
 * - vector/score 계산 후 webview로 전송
 * - 승인 시 파일 저장 (자동 파일명/폴더 생성)
 */

/** 활성화 */
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

/** 설정 읽기 */
function getCfg() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    endpoint: (cfg.get<string>("aiApproval.ollama.endpoint") || "http://210.110.103.64:11434").replace(/\/$/, ""),
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3.1:8b"
  };
}

/** 메시지 처리(웹뷰 -> 확장) */
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "approve": {
          // note: webview sends score/severity as part of payload
          const code = msg?.code ?? "";
          const language = msg?.language ?? "plaintext";
          const filename = msg?.filename ?? null;
          const score = typeof msg?.score === "number" ? msg.score : null;
          const severity = msg?.severity ?? null;

          // If severity is red, show modal confirmation
          if (severity === "red") {
            const confirmed = await vscode.window.showWarningMessage(
              `이 변경은 높은 위험 점수(${score})입니다. 정말 저장하시겠습니까?`,
              { modal: true },
              "확인",
              "취소"
            );
            if (confirmed !== "확인") {
              vscode.window.showInformationMessage("승인 취소됨");
              return;
            }
          }

          await handleApproval(code, language, filename);
          break;
        }

        case "reject": {
          vscode.window.showWarningMessage("거절되었습니다 ❌ (코드는 저장되지 않았습니다)");
          break;
        }

        case "details": {
          // 아직 간단히 알림 처리 (확장 확장 가능)
          vscode.window.showInformationMessage("자세히 보기: 확장에서 추가 동작을 구현할 수 있습니다.");
          break;
        }

        case "ask": {
          const { endpoint, model } = getCfg();
          // accumulate response text on extension side so we can analyze
          try {
            const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
              // forward tokens to webview for streaming UI
              webview.postMessage({ type: "delta", text: delta });
            });

            // extract last code block (if any)
            const snippet = extractLastCodeBlock(fullText); // { language, code } | null

            // detect suggested filename from fullText
            const suggested = detectSuggestedFileName(fullText, snippet?.language ?? "plaintext");

            // analyze (vector)
            const analysis = analyzeGeneratedText(fullText, snippet?.code ?? "", suggested);
            const scored = scoreFromVector(analysis.vector);

            // send analysis info to webview (vector, score, severity, suggested filename)
            webview.postMessage({
              type: "analysis",
              vector: analysis.vector,
              score: scored.score,
              severity: scored.severity,
              suggestedFilename: suggested || null,
              language: snippet?.language ?? "plaintext",
              code: snippet?.code ?? ""
            });

            // finally notify done (webview will present approval card if code exists)
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
      console.error("webview message error:", e);
      const detail = e?.message || String(e);
      webview.postMessage({ type: "error", message: detail });
      vscode.window.showErrorMessage(detail);
    }
  });
}

/** === Ollama 호출 (스트리밍) + 전체 텍스트를 문자열로 반환 === */
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
        // partial line; continue
      }
    }
  }

  return full;
}

/** === 분석(heuristic) 및 스코어링 === */
function analyzeGeneratedText(fullText: string, code: string, filename?: string | null) {
  // F: Function change
  let F = 0;
  const funcKeywords = /\b(replace|rewrite|refactor|rework|rewrite core|change core|alter core|replace core)\b/i;
  if (funcKeywords.test(fullText)) F += 0.6;
  if (filename && /(?:^|\/)(?:main|server|app|index|core)\.[a-z0-9]+$/i.test(filename)) F = Math.min(1, F + 0.3);
  if (code.length > 2000) F = Math.min(1, F + 0.2);

  // R: Stability / resource risk
  let R = 0;
  const heavyPatterns = /\b(while\s*\(|for\s*\(|sleep\(|thread|fork|subprocess|multiprocessing|spawn|map_reduce|batch|malloc|calloc|new\s+[A-Z])/i;
  if (heavyPatterns.test(code + " " + fullText)) R += 0.4;
  if (code.split("\n").length > 200) R = Math.min(1, R + 0.2);

  // S: Security / dependency
  let S = 0;
  const depMatches = Array.from((fullText + " " + code).matchAll(/(?:import\s+([a-z0-9_.\-]+)|require\(['"]([a-z0-9_.\-]+)['"]\))/ig));
  if (depMatches.length > 0) S += Math.min(0.6, 0.15 * depMatches.length);
  if (/\beval\(|exec\(|system\(|popen\(|open\([^,]*\/etc\/passwd|sshpass\b/i.test(code + " " + fullText)) S = Math.min(1, S + 0.6);

  F = Math.min(1, Math.max(0, F));
  R = Math.min(1, Math.max(0, R));
  S = Math.min(1, Math.max(0, S));

  return { vector: [F, R, S], code, filename };
}

function scoreFromVector(v: number[]) {
  const w = [0.4, 0.35, 0.25];
  const raw = v[0] * w[0] + v[1] * w[1] + v[2] * w[2]; // 0..1
  const score = Math.round(raw * 100);
  let severity: "green" | "yellow" | "red" = "green";
  if (score >= 70) severity = "red";
  else if (score >= 40) severity = "yellow";
  return { score, severity };
}

/** === 유틸: 코드 블록 추출 (마지막 블록) === */
function extractLastCodeBlock(text: string): { language: string; code: string } | null {
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

/** === 유틸: 파일명 힌트 감지 === */
function detectSuggestedFileName(fullText: string, fallbackLang?: string | null): string | null {
  const re = /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*|^|\s)([A-Za-z0-9_\-./]+?\.[A-Za-z0-9]{1,8})/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(fullText)) !== null) last = m[1];
  if (!last) return null;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(last)) return null;
  if (last.includes("..")) return null;
  // optional: filter extreme mismatches (not strict)
  if (fallbackLang && fallbackLang.toLowerCase() === "html" && last.toLowerCase().endsWith(".py")) return null;
  return last.replace(/^\/+/, "");
}

/** 파일 저장 관련 (자동 이름/폴더 생성) */
/** 승인 시 코드 파일에 쓰기 또는 터미널에서 실행 (자동 파일명/폴더 생성) */
async function handleApproval(code: string, language: string, suggested?: string | null) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
    return;
  }

  // --- 1) 명령어인지 감지 (터미널로 보낼지 판단) ---
  const shellCmdPattern = /^(npm|yarn|pip|pip3|pnpm|apt|apt-get|brew|git|chmod|chown|sudo|rm|mv|cp|mkdir|rmdir|systemctl|service)\b/i;
  const firstLine = (code || "").trim().split(/\r?\n/)[0] || "";
  const looksLikeShell = language === "bash" || language === "sh" || shellCmdPattern.test(firstLine);

  if (looksLikeShell) {
    // 안전 확인(모달)
    const confirm = await vscode.window.showWarningMessage(
      "발견된 내용이 터미널 명령어로 보입니다. 통합 터미널에서 실행하시겠습니까?",
      { modal: true },
      "실행",
      "취소"
    );
    if (confirm !== "실행") {
      vscode.window.showInformationMessage("터미널 실행이 취소되었습니다.");
      return;
    }

    // 새로운 또는 기존 터미널 사용
    const termName = "AI Approval Agent";
    let terminal = vscode.window.terminals.find(t => t.name === termName);
    if (!terminal) {
      terminal = vscode.window.createTerminal({ name: termName });
    }
    terminal.show(true);

    // 여러 줄이면 한 줄씩 실행 (주석/빈줄은 건너뜀)
    const lines = code.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
    for (const line of lines) {
      // 안전을 위해 한 줄씩 실행 (추가로 필요하면 사용자에게 보여주거나 로그 기록 가능)
      terminal.sendText(line, true); // addNewLine=true -> 실행
    }

    vscode.window.showInformationMessage(`터미널에서 명령을 실행했습니다 (${lines.length} 줄).`);
    return;
  }

  // --- 2) 일반 코드 파일로 저장(기존 로직) ---
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
    plaintext: "txt"
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

/** getHtml / getNonce (unchanged) */
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

export function deactivate() {}
