const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

// 기본 가드
if (!chat || !form || !input) {
  console.error("webview DOM not ready: missing #chat/#composer/#prompt");
}

// 말풍선 유틸
function append(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

let botDiv = null;
let lastBotBuffer = "";

function startBotLine() {
  botDiv = document.createElement("div");
  botDiv.className = "msg bot";
  botDiv.textContent = "";
  chat.appendChild(botDiv);
  chat.scrollTop = chat.scrollHeight;
}

// HTML escape
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ```lang\n...\n``` or ```\n...\n```
function extractLastCodeBlock(text) {
  const regex = /```([\s\S]*?)```/g;
  let match, last = null;
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

// 마지막 봇 전체 텍스트에서 파일명 후보 찾기
function detectSuggestedFileName(fullText, fallbackLang) {
  const re = /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*|^|\s)([A-Za-z0-9_\-./]+?\.[A-Za-z0-9]{1,8})/gi;
  let m, last = null;
  while ((m = re.exec(fullText)) !== null) last = m[1];
  if (!last) return null;

  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(last);
  if (!hasExt) return null;
  if (fallbackLang && last.toLowerCase().endsWith(".py") && fallbackLang.toLowerCase() === "html") {
    return null; // 언어와 확장자 극단 불일치 예시 가드
  }
  if (last.includes("..")) return null; // 상위 경로 방지
  return last.replace(/^\/+/, "");
}

// 승인 카드(단일 정의)
function renderApprovalCard(snippet) {
  const { language, code, filename } = snippet;

  const card = document.createElement("div");
  card.className = "approval-card critical";
  card.innerHTML = `
    <div class="badge">REVIEW<br/>승인 필요</div>
    <div class="card-main">
      <h3>생성된 코드 검토</h3>
      <ul class="meta">
        <li>언어: ${escapeHtml(language || "plaintext")}</li>
        <li>길이: ${code.length} chars</li>
        ${filename ? `<li>파일명 제안: ${escapeHtml(filename)}</li>` : ""}
      </ul>
      <pre class="code-preview"><code>${escapeHtml(
        code.slice(0, 1200)
      )}${code.length > 1200 ? "\n... (truncated)" : ""}</code></pre>
      <div class="actions">
        <button class="approve-btn">승인</button>
        <button class="reject-btn ghost">거절</button>
        <button class="details-btn outline">자세히 보기</button>
      </div>
    </div>
  `;
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;

  card.querySelector(".approve-btn").addEventListener("click", () => {
    vscode.postMessage({ type: "approve", code, language, filename: filename || null });
  });
  card.querySelector(".reject-btn").addEventListener("click", () => {
    vscode.postMessage({ type: "reject", code, language, filename: filename || null });
  });
  card.querySelector(".details-btn").addEventListener("click", () => {
    vscode.postMessage({ type: "details", code, language, filename: filename || null });
  });
}

// 메시지 수신
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.type === "delta") {
    if (!botDiv) startBotLine();
    botDiv.textContent += msg.text;
    lastBotBuffer += msg.text;
    chat.scrollTop = chat.scrollHeight;
  } else if (msg.type === "done") {
    botDiv = null;
    const snippet = extractLastCodeBlock(lastBotBuffer);
    if (snippet && snippet.code.trim().length > 0) {
      const hint = detectSuggestedFileName(
        lastBotBuffer,
        snippet.language === "plaintext" ? "" : snippet.language
      );
      renderApprovalCard({ ...snippet, filename: hint || null });
    }
  } else if (msg.type === "error") {
    append("bot", `⚠️ ${msg.message}`);
    botDiv = null;
  }
});

// 입력 전송
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  append("user", text);
  vscode.postMessage({ type: "ask", text });
  input.value = "";
  startBotLine();
  lastBotBuffer = "";
});
