import * as vscode from "vscode";

/**
 * 확장이 활성화될 때 실행됨
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
 * WebviewViewProvider 클래스
 */
class ApprovalViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, "src", "webview")
      ]
    };
    const nonce = getNonce();
    view.webview.html = getHtml(view.webview, this.ctx, nonce);
    wireMessages(view.webview);
  }
}

/**
 * HTML 생성
 */
function getHtml(
  webview: vscode.Webview,
  ctx: vscode.ExtensionContext,
  nonce: string
): string {
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
    <div class="chat-header">Fix module not found errors</div>

    <div class="chat-body" id="chat">
      <div class="msg user">sql<br/><code>SELECT * FROM USERS;</code></div>
      <div class="msg bot">좋습니다! 새 사용자가 성공적으로 등록되었습니다.</div>

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

/**
 * Webview → Extension 메시지 핸들링
 */
function wireMessages(webview: vscode.Webview) {
  webview.onDidReceiveMessage((msg) => {
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
    }
  });
}

/**
 * CSP 안전용 nonce 생성
 */
function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 16; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * 확장 비활성화될 때 실행됨
 */
export function deactivate() {}
