import * as vscode from "vscode";

/**
 * 확장 활성화
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

/**
 * WebviewViewProvider
 */
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

/**
 * VS Code 설정값 읽기
 */
function getCfg() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    endpoint: (cfg.get<string>("aiApproval.ollama.endpoint") || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: cfg.get<string>("aiApproval.ollama.model") || "llama3"
  };
}

/**
 * Webview ↔ Extension 메시지
 */
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case "approve":
        vscode.window.showInformationMessage("승인되었습니다 ✅");
        break;
      case "reject":
        vscode.window.showWarningMessage("거절되었습니다 ❌");
        break;
      case "details":
        vscode.window.showInformationMessage("자세히 보기 클릭됨 ℹ️");
        break;
      case "ask": {
        const { endpoint, model } = getCfg();
        try {
          await chatWithOllama(endpoint, model, msg.text, (delta) => {
            webview.postMessage({ type: "delta", text: delta });
          });
          webview.postMessage({ type: "done" });
        } catch (e: any) {
          const message = e?.message || String(e);
          vscode.window.showErrorMessage(`Ollama 호출 실패: ${message}`);
          webview.postMessage({ type: "error", message });
        }
        break;
      }
    }
  });
}

/**
 * Ollama /api/chat 스트리밍 호출
 * 응답은 \n 단위 JSON Line 으로 도착 -> message.content 누적
 */
async function chatWithOllama(
  endpoint: string,
  model: string,
  userText: string,
  onDelta: (text: string) => void
) {
  // Node18의 fetch 사용 (타입 경고 피하기 위해 any로 받음)
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
        // obj.done === true 이면 서버가 끝을 알린 것
      } catch {
        // 불완전한 줄은 다음 chunk와 합쳐서 다시 파싱
      }
    }
  }
}

/**
 * Webview HTML
 */
function getHtml(webview: vscode.Webview, ctx: vscode.ExtensionContext, nonce: string): string {
  const base = vscode.Uri.joinPath(ctx.extensionUri, "src", "webview");
  const js  = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.js"));
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
    <div class="chat-header">Fix module not found errors</div>

    <div class="chat-body" id="chat">
      <div class="msg user">sql<br/><code>SELECT * FROM USERS;</code></div>
      <div class="msg bot">좋습니다! 새 사용자가 성공적으로 등록되었습니다. 이제 로그인을 테스트해볼게요.</div>

      <div class="approval-card critical">
        <div class="badge">CRITICAL<br/>승인 필수</div>
        <div class="card-main">
          <h3>Change a prove</h3>
          <ul class="meta">
            <li>보안/인증</li>
            <li>DB 스키마 변경</li>
            <li>점수 6</li>
          </ul>

          <div class="actions">
            <button id="approve">승인</button>
            <button id="reject" class="ghost">거절</button>
            <button id="details" class="outline">자세히 보기</button>
          </div>
        </div>
      </div>
    </div>

    <form id="composer">
      <input id="prompt" type="text" placeholder="Plan, search, build anything" />
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
