/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

// 안전 가드
if (!chat || !form || !input) {
  console.error("webview DOM not ready: missing #chat/#composer/#prompt");
}

// --- 모달 스타일(동적 삽입) ---
(function injectModalStyles() {
  const css = `
/* analysis modal */
.analysis-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display:flex;
  align-items:center;
  justify-content:center;
  z-index: 9999;
  padding: 20px;
  box-sizing: border-box;
}
.analysis-modal {
  width: 860px;
  max-width: 100%;
  max-height: 90vh;
  overflow:auto;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #ddd);
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6);
  font-family: var(--vscode-font-family, "Segoe UI", Roboto, "Helvetica Neue", Arial);
  border: 1px solid rgba(255,255,255,0.04);
}
.analysis-modal h2 { margin:0 0 8px 0; font-size:18px; }
.analysis-modal .kpi { display:flex; gap:12px; align-items:center; margin-bottom:12px; }
.analysis-modal .kpi .big { font-weight:700; font-size:28px; padding:8px 12px; border-radius:6px; }
.analysis-modal .kpi .green { background:#1e7a2d; color:white; }
.analysis-modal .kpi .yellow { background:#b8860b; color:white; }
.analysis-modal .kpi .red { background:#b31c1c; color:white; }
.analysis-modal .vector-row { display:flex; gap:16px; margin-bottom:8px; }
.analysis-modal .vector-row .item { min-width:80px; }
.analysis-modal .section { margin-top:12px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.03); }
.analysis-modal .reasons { margin-top:8px; }
.analysis-modal pre { background: rgba(0,0,0,0.2); padding:10px; border-radius:6px; overflow:auto; white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size:12px; }
.analysis-modal .close-btn { position:absolute; right:18px; top:14px; background:transparent; border:0; color:inherit; cursor:pointer; font-size:18px; }
.analysis-modal .footer { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
.analysis-modal .explain { font-size:13px; color:var(--vscode-descriptionForeground,#cfcfcf); }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

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
 */
function detectSuggestedFileName(fullText, fallbackLang) {
  const re =
    /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*)([A-Za-z0-9_\-./]+?\.[A-Za-z]{1,8})/gi;
  let m,
    last = null;
  while ((m = re.exec(fullText)) !== null) last = m[1];
  if (!last) return null;

  const extMatch = last.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!extMatch) return null;
  const ext = extMatch[1];
  if (!/[A-Za-z]/.test(ext)) return null;
  if (/^\d+(\.\d+)+$/.test(last)) return null;
  if (last.includes("..")) return null;
  if (fallbackLang && fallbackLang.toLowerCase() === "html" && last.toLowerCase().endsWith(".py")) {
    return null;
  }

  return last.replace(/^\/+/, "");
}

/**
 * 상세 모달 표시
 * - analysis: { vector: [F,R,S], score, severity, reasons }
 * - snippet: { language, code, filename }
 */
function showAnalysisModal(analysis = {}, snippet = {}) {
  // 중복 모달 방지
  if (document.querySelector(".analysis-modal-overlay")) return;

  const vector = Array.isArray(analysis.vector) ? analysis.vector : [0, 0, 0];
  const F = Math.round((vector[0] || 0) * 100);
  const R = Math.round((vector[1] || 0) * 100);
  const S = Math.round((vector[2] || 0) * 100);

  // 같은 가중치 사용 (확장: 이 값을 서버(확장)와 동기화하면 좋음)
  const weights = { F: 0.4, R: 0.35, S: 0.25 };
  const raw =
    (vector[0] || 0) * weights.F + (vector[1] || 0) * weights.R + (vector[2] || 0) * weights.S;
  const computedScore = Math.round(raw * 100);
  const severity = analysis.severity || (computedScore >= 70 ? "red" : computedScore >= 40 ? "yellow" : "green");

  const reasons = analysis.reasons || {};

  const overlay = document.createElement("div");
  overlay.className = "analysis-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "analysis-modal";

  modal.innerHTML = `
    <button class="close-btn" title="Close">&times;</button>
    <h2>승인 상세 분석 결과</h2>
    <div class="kpi">
      <div class="big ${severity}">${computedScore}</div>
      <div style="flex:1">
        <div style="font-weight:700">${(severity==='red')? '승인 필수 (Human review required)' : (severity==='yellow')? '승인 필요' : '안전 (자동 승인 가능)'}</div>
        <div class="explain">점수 산정식: score = round( F*${weights.F} + R*${weights.R} + S*${weights.S} ) * 100</div>
      </div>
    </div>

    <div class="vector-row">
      <div class="item"><strong>F (기능 변경)</strong><div>${F}%</div></div>
      <div class="item"><strong>R (안정성)</strong><div>${R}%</div></div>
      <div class="item"><strong>S (보안/의존성)</strong><div>${S}%</div></div>
    </div>

    <div class="section">
      <div style="font-weight:700">가중치 (현재 설정)</div>
      <div class="explain">F: ${weights.F} &nbsp; R: ${weights.R} &nbsp; S: ${weights.S} &nbsp; (합: ${weights.F+weights.R+weights.S})</div>
      <pre>raw = F*${weights.F} + R*${weights.R} + S*${weights.S}
score = round(raw * 100)
      </pre>
    </div>

    <div class="section">
      <div style="font-weight:700">취약점/판단 근거 (LLM/휴리스틱)</div>
      <div class="reasons">
        ${reasons.function_change ? `<div><strong>기능변경:</strong> ${escapeHtml(reasons.function_change)}</div>` : ""}
        ${reasons.stability_risk ? `<div><strong>안정성:</strong> ${escapeHtml(reasons.stability_risk)}</div>` : ""}
        ${reasons.security_dependency ? `<div><strong>보안/의존성:</strong> ${escapeHtml(reasons.security_dependency)}</div>` : ""}
        ${(!reasons.function_change && !reasons.stability_risk && !reasons.security_dependency) ? `<div class="explain">추가 설명이 없습니다.</div>` : ""}
      </div>
    </div>

    <div class="section">
      <div style="font-weight:700">관련 코드 스니펫</div>
      <div class="explain">파일명 제안: ${escapeHtml(snippet.filename || "(없음)")}</div>
      <pre>${escapeHtml((snippet.code || "").slice(0, 2000))}${(snippet.code && snippet.code.length>2000) ? "\n... (truncated)" : ""}</pre>
    </div>

    <div class="footer">
      <button class="close-btn primary">X</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function removeModal() {
    try { overlay.remove(); } catch{ /* ignore */ }
    window.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") removeModal();
  }

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) removeModal();
  });

  modal.querySelectorAll(".close-btn").forEach(btn => btn.addEventListener("click", removeModal));
  window.addEventListener("keydown", onKey);
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
          ? `<div class="vector-line" style="display:flex;gap:12px;margin-bottom:8px;">
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

  // 자세히 보기: analysis + snippet을 모달로 보여줌
  card.querySelector(".details-btn")?.addEventListener("click", () => {
    // analysis may be null — fallback
    const a = analysis || { vector: vector || [0,0,0], score: score ?? 0, severity: severity ?? "green", reasons: reasons || {} };
    showAnalysisModal(a, { language: language, code: code, filename: filename });
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
