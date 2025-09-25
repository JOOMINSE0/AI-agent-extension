const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

// 안전 가드
if (!chat || !form || !input) {
  console.error("webview DOM not ready: missing #chat/#composer/#prompt");
}

// 유틸: append
function append(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

let botDiv = null;
let lastBotBuffer = "";

// 시작 새 봇 라인
function startBotLine() {
  botDiv = document.createElement("div");
  botDiv.className = "msg bot";
  botDiv.textContent = "";
  chat.appendChild(botDiv);
  chat.scrollTop = chat.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractLastCodeBlock(text) {
  const regex = /```([\s\S]*?)```/g;
  let match;
  let last = null;
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

function detectSuggestedFileName(fullText, fallbackLang) {
  const re = /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*|^|\s)([A-Za-z0-9_\-./]+?\.[A-Za-z0-9]{1,8})/gi;
  let m, last = null;
  while ((m = re.exec(fullText)) !== null) last = m[1];
  if (!last) return null;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(last)) return null;
  if (last.includes("..")) return null;
  if (fallbackLang && fallbackLang.toLowerCase() === "html" && last.toLowerCase().endsWith(".py")) return null;
  return last.replace(/^\/+/, "");
}

// render approval card (single definition)
function renderApprovalCard(snippet, analysis) {
  const { language, code, filename } = snippet;
  const score = analysis?.score ?? null;
  const severity = analysis?.severity ?? null;
  const vector = analysis?.vector ?? null;

  const card = document.createElement("div");
  card.className = "approval-card critical";
  card.innerHTML = `
    <div class="badge">REVIEW<br/>승인 필요</div>
    <div class="card-main">
      <div class="score-banner ${severity || 'green'}">
        <div class="score-value">${score ?? ''}</div>
        <div class="score-label">${severity ? severity.toUpperCase() : ''}</div>
      </div>
      <h3>생성된 코드 검토</h3>
      <ul class="meta">
        <li>언어: ${escapeHtml(language || "plaintext")}</li>
        <li>길이: ${code.length} chars</li>
        ${filename ? `<li>파일명 제안: ${escapeHtml(filename)}</li>` : ""}
      </ul>
      <pre class="code-preview"><code>${escapeHtml(code.slice(0, 1200))}${code.length > 1200 ? "\n... (truncated)" : ""}</code></pre>
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
    vscode.postMessage({
      type: "approve",
      code,
      language,
      filename: filename || null,
      score,
      severity
    });
  });
  card.querySelector(".reject-btn").addEventListener("click", () => {
    vscode.postMessage({
      type: "reject",
      code,
      language,
      filename: filename || null,
      score,
      severity
    });
  });
  card.querySelector(".details-btn").addEventListener("click", () => {
    vscode.postMessage({
      type: "details",
      code,
      language,
      filename: filename || null,
      score,
      severity
    });
  });
}

// show analysis banner if analysis message arrives separately
function showAnalysisBannerOnTopOfCard(card, analysis) {
  // not used now because renderApprovalCard already shows banner
}

// 메시지 수신
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.type === "delta") {
    if (!botDiv) startBotLine();
    botDiv.textContent += msg.text;
    lastBotBuffer += msg.text;
    chat.scrollTop = chat.scrollHeight;
  } else if (msg.type === "analysis") {
    // analysis: vector, score, severity, suggestedFilename, language, code
    // We don't render immediately here; we wait for done to create approval card
    // But store analysis on a temporary var
    window.__lastAnalysis = {
      vector: msg.vector,
      score: msg.score,
      severity: msg.severity,
      suggestedFilename: msg.suggestedFilename,
      language: msg.language,
      code: msg.code
    };
  } else if (msg.type === "done") {
    botDiv = null;
    const snippet = extractLastCodeBlock(lastBotBuffer);
    if (snippet && snippet.code.trim().length > 0) {
      const hint = detectSuggestedFileName(lastBotBuffer, snippet.language === "plaintext" ? "" : snippet.language);
      const analysis = window.__lastAnalysis || null;
      // If analysis exists, prefer suggestedFilename from analysis
      if (analysis && analysis.suggestedFilename) {
        snippet.filename = analysis.suggestedFilename;
      } else {
        snippet.filename = hint || null;
      }
      // pass analysis object to renderApprovalCard
      renderApprovalCard({ ...snippet }, analysis);
    }
    // reset buffer/analysis for next turn
    lastBotBuffer = "";
    window.__lastAnalysis = null;
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
  window.__lastAnalysis = null;
});
