import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/** 확장 활성화 */
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

/** VS Code 설정값 */
function getCfg() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    endpoint: (cfg.get<string>("aiApproval.ollama.endpoint") || "http://210.110.103.64:11434").replace(/\/$/, ""),
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3.1:8b"
  };
}

/** Webview ↔ Extension 메시지 */
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
    case "approve": {
      const code = msg?.code ?? "";
      const language = msg?.language ?? "txt";
      const filename = msg?.filename ?? null;
      await handleApproval(code, language, filename);
      break;
    }

      case "reject": {
        vscode.window.showWarningMessage("거절되었습니다 ❌ (코드는 저장되지 않았습니다)");
        break;
      }
      case "details": {
        vscode.window.showInformationMessage("자세히 보기 클릭됨 ℹ️");
        break;
      }
      case "ask": {
        const { endpoint, model } = getCfg();
        try {
          await chatWithOllama(endpoint, model, msg.text, (delta) => {
            webview.postMessage({ type: "delta", text: delta });
          });
          webview.postMessage({ type: "done" });
        } catch (e: any) {
          const detail = e?.message || e?.cause?.message || e?.cause?.code || String(e);
          vscode.window.showErrorMessage(`Ollama 호출 실패: ${detail}`);
          webview.postMessage({ type: "error", message: detail });
        }
        break;
      }
    }
  });
}

/** 승인 시 코드 파일에 쓰기 (자동 파일명/폴더 생성) */
async function handleApproval(code: string, language: string, suggested?: string | null) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
    return;
  }

  const root = vscode.workspace.workspaceFolders[0].uri;

    // 1) 파일명 후보: 답변에서 감지된 파일명 > 자동 생성
  const ext = guessExtension(language);
  let targetRel = sanitizeRelativePath(suggested) || await nextAutoName(root, ext);

  // 하위 폴더가 있다면 미리 생성
  await ensureParentDir(root, targetRel);

  const fileUri = vscode.Uri.joinPath(root, targetRel);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, "utf-8"));

  vscode.window.showInformationMessage(`승인됨 ✅ → ${targetRel} 저장 완료`);
  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
}

/** 언어 → 파일 확장자 */
function guessExtension(language: string): string {
  const map: Record<string,string> = {
    javascript: "js", typescript: "ts", python: "py",
    html: "html", css: "css", java: "java",
    c: "c", cpp: "cpp", tsx: "tsx", jsx: "jsx",
    json: "json", plaintext: "txt"
  };
  const key = (language || "").toLowerCase().trim();
  return map[key] || (key.match(/^[a-z0-9]+$/) ? key : "txt");
}

/** 상대 경로 안전화 (상위폴더 탈출 차단) */
function sanitizeRelativePath(p?: string | null): string | null {
  if (!p) return null;
  if (p.includes("..")) return null;
  return p.replace(/^\/+/, "").trim();
}

/** 자동 파일명: generated_code_001.ext, 002... (중복 회피) */
async function nextAutoName(root: vscode.Uri, ext: string): Promise<string> {
  const base = "generated_code";
  for (let i = 1; i <= 9999; i++) {
    const name = `${base}_${String(i).padStart(3, "0")}.${ext}`;
    const uri = vscode.Uri.joinPath(root, name);
    try {
      await vscode.workspace.fs.stat(uri);
      // 존재하면 계속 증가
    } catch {
      return name; // 없으면 이 이름 사용
    }
  }
  return `${base}_${Date.now()}.${ext}`;
}

/** 상위 디렉토리 생성 */
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
/** Ollama 채팅 */
async function chatWithOllama(
  endpoint: string,
  model: string,
  userText: string,
  onDelta: (text: string) => void
) {
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
        if (piece) onDelta(piece);
      } catch {
        /* partial line; continue */
      }
    }
  }
}

/** HTML */
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

    <div class="chat-body" id="chat"></div>

    <form id="composer">
      <input id="prompt" type="text" placeholder="예) express 서버 초기 코드 만들어줘" />
      <button type="submit">Send</button>
    </form>
  </section>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

/** CSP nonce */
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** 비활성화 */
export function deactivate() {}
