/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

// 안전 가드
if (!chat || !form || !input) {
  console.error("webview DOM not ready: missing #chat/#composer/#prompt");
}

// 유틸: escape & append
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function append(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

let botDiv = null;
let lastBotBuffer = "";

// 새 봇 라인 시작
function startBotLine() {
  botDiv = document.createElement("div");
  botDiv.className = "msg bot";
  botDiv.textContent = "";
  chat.appendChild(botDiv);
  chat.scrollTop = chat.scrollHeight;
}

// 마지막 코드블록 추출 ( ```lang\ncode``` )
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

/**
 * 파일명 힌트 추출 (강화판)
 * - 확장자에 영문자 1개 이상 필요
 * - 순수 버전 문자열(예: 5.7, 12.1.0) 제외
 * - 상위경로 차단
 * - lang과 극단적으로 어긋나는 경우는 드랍(간단 예시)
 */
function detectSuggestedFileName(fullText, fallbackLang) {
  const re =
    /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*)([A-Za-z0-9_\-./]+?\.[A-Za-z]{1,8})/gi;
  let m,
    last = null;
  while ((m = re.exec(fullText)) !== null) last = m[1];
  if (!last) return null;

  // 확장자 검사
  const extMatch = last.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!extMatch) return null;
  const ext = extMatch[1];
  if (!/[A-Za-z]/.test(ext)) return null; // 영문 1+ 필수 (버전 숫자형 제외)

  // 순수 버전 문자열 차단 (예: 5.7, 12.0.3)
  if (/^\d+(\.\d+)+$/.test(last)) return null;

  // 상위 경로 차단
  if (last.includes("..")) return null;

  // 간단한 언어-확장자 상충 방지 예시 (필요 시 확장)
  if (fallbackLang && fallbackLang.toLowerCase() === "html" && last.toLowerCase().endsWith(".py")) {
    return null;
  }

  return last.replace(/^\/+/, "");
}

/**
 * 승인 카드 렌더링
 * - analysis.score / analysis.severity / analysis.vector / analysis.reasons 반영
 */
function renderApprovalCard(snippet, analysis) {
  const { language, code } = snippet;
  const filename = snippet.filename || null;
  const score = analysis?.score ?? null;
  const severity = analysis?.severity ?? null;
  const vector = Array.isArray(analysis?.vector) ? analysis.vector : null; // [F,R,S] 0..1
  const reasons = analysis?.reasons || {};

  // 벡터를 %로 표기
  const fmtPct = (x) => (typeof x === "number" ? Math.round(x * 100) : 0);
  const F = vector ? fmtPct(vector[0]) : null;
  const R = vector ? fmtPct(vector[1]) : null;
  const S = vector ? fmtPct(vector[2]) : null;

  const card = document.createElement("div");
  card.className = "approval-card critical";
  card.innerHTML = `
    <div class="badge">REVIEW<br/>승인 필요</div>
    <div class="card-main">
      <div class="score-banner ${severity || "green"}">
        <div class="score-value">${score ?? ""}</div>
        <div class="score-label">${severity ? severity.toUpperCase() : ""}</div>
      </div>

      ${
        vector
          ? `<div class="vector-line">
              <span>F ${F}%</span>
              <span>R ${R}%</span>
              <span>S ${S}%</span>
            </div>`
          : ""
      }

      ${
        (reasons.function_change || reasons.stability_risk || reasons.security_dependency)
          ? `<div class="reasons">
              ${reasons.function_change ? `<div>기능변경: ${escapeHtml(reasons.function_change)}</div>` : ""}
              ${reasons.stability_risk ? `<div>안정성: ${escapeHtml(reasons.stability_risk)}</div>` : ""}
              ${reasons.security_dependency ? `<div>보안/의존성: ${escapeHtml(reasons.security_dependency)}</div>` : ""}
            </div>`
          : ""
      }

      <h3>생성된 코드 검토</h3>
      <ul class="meta">
        <li>언어: ${escapeHtml(language || "plaintext")}</li>
        <li>길이: ${code.length} chars</li>
        ${filename ? `<li>파일명 제안: ${escapeHtml(filename)}</li>` : ""}
      </ul>

      <pre class="code-preview"><code>${escapeHtml(code.slice(0, 1200))}${
        code.length > 1200 ? "\n... (truncated)" : ""
      }</code></pre>

      <div class="actions">
        <button class="approve-btn">승인</button>
        <button class="reject-btn ghost">거절</button>
        <button class="details-btn outline">자세히 보기</button>
      </div>
    </div>
  `;

  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;

  // 버튼 핸들러
  card.querySelector(".approve-btn")?.addEventListener("click", () => {
    vscode.postMessage({
      type: "approve",
      code,
      language,
      filename,
      score,
      severity
    });
  });

  card.querySelector(".reject-btn")?.addEventListener("click", () => {
    vscode.postMessage({
      type: "reject",
      code,
      language,
      filename,
      score,
      severity
    });
  });

  card.querySelector(".details-btn")?.addEventListener("click", () => {
    vscode.postMessage({
      type: "details",
      code,
      language,
      filename,
      score,
      severity
    });
  });
}

// 메시지 수신
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg) return;

  if (msg.type === "delta") {
    if (!botDiv) startBotLine();
    botDiv.textContent += msg.text || "";
    lastBotBuffer += msg.text || "";
    chat.scrollTop = chat.scrollHeight;
    return;
  }

  if (msg.type === "analysis") {
    // analysis: { vector, score, severity, suggestedFilename, language, code, reasons? }
    window.__lastAnalysis = {
      vector: msg.vector,
      score: msg.score,
      severity: msg.severity,
      suggestedFilename: msg.suggestedFilename,
      language: msg.language,
      code: msg.code,
      reasons: msg.reasons || {}
    };
    return;
  }

  if (msg.type === "done") {
    botDiv = null;
    const snippet = extractLastCodeBlock(lastBotBuffer);
    if (snippet && snippet.code && snippet.code.trim().length > 0) {
      const hint = detectSuggestedFileName(
        lastBotBuffer,
        snippet.language === "plaintext" ? "" : snippet.language
      );
      const analysis = window.__lastAnalysis || null;

      // 분석에서 제안된 파일명이 있으면 우선 사용
      if (analysis && analysis.suggestedFilename) {
        snippet.filename = analysis.suggestedFilename;
      } else {
        snippet.filename = hint || null;
      }

      renderApprovalCard({ ...snippet }, analysis);
    }
    // 다음 턴을 위해 초기화
    lastBotBuffer = "";
    window.__lastAnalysis = null;
    return;
  }

  if (msg.type === "error") {
    append("bot", `⚠️ ${msg.message}`);
    botDiv = null;
    return;
  }
});

// 입력 전송
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = (input.value || "").trim();
  if (!text) return;

  append("user", text);
  vscode.postMessage({ type: "ask", text });

  input.value = "";
  startBotLine();
  lastBotBuffer = "";
  window.__lastAnalysis = null;
});
