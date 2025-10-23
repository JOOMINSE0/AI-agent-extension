/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

// 대화 히스토리 (모델 맥락 유지를 위해 확장으로 함께 전송)
const history = []; // [{ role: "user" | "assistant", content: string }]

// 안전 가드
if (!chat || !form || !input) {
  console.error("webview DOM not ready: missing #chat/#composer/#prompt");
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ① 채팅/카드 스타일 주입 (모달/디테일/분해점수 UI 전부 제거)
 * ────────────────────────────────────────────────────────────────────────────*/
(function injectChatStyles() {
  const css = `
#chat { display:flex; flex-direction:column; gap:6px; }

/* 기본 메시지 버블 */
.msg {
  margin: 6px 0;
  padding: 6px 10px;
  border-radius: 6px;
  max-width: 90%;
  line-height: 1.4;
  word-wrap: break-word;
}
.msg.user {
  background: #007acc;
  color: white;
  align-self: flex-end;
}
.msg.bot {
  background: #2d2d2d;
  color: #f0f0f0;
  align-self: flex-start;
}

/* 마크다운 본문 */
.msg.bot .md { line-height:1.6; }
.msg.bot .md h1,.msg.bot .md h2,.msg.bot .md h3{ margin:10px 0 6px; font-weight:700; }
.msg.bot .md h1{ font-size:16px; } .msg.bot .md h2{ font-size:15px; } .msg.bot .md h3{ font-size:14px; }
.msg.bot .md p{ margin:6px 0; }
.msg.bot .md code{ padding:1px 4px; border-radius:4px; background:rgba(255,255,255,0.08); }
.msg.bot .md pre{ background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.08);
  padding:10px; border-radius:8px; overflow:auto; white-space:pre; font-size:12px; }
.msg.bot .md .fence-title{ opacity:.85; font-size:12px; margin:6px 0 -2px; }
.msg.bot .md .codebox{ position:relative; }
.msg.bot .md .copy{ position:absolute; top:8px; right:8px; font-size:11px;
  padding:4px 6px; border-radius:6px; background:#2e2e2e; color:#ddd; border:1px solid #555; cursor:pointer;}

/* 승인 카드 (요약 전용 UI) */
.approval-card {
  border: 1px solid var(--vscode-editorWidget-border, #555);
  border-radius: 12px;
  margin: 10px 0;
  padding: 12px;
  background: var(--vscode-editorWidget-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #ddd);
}
.approval-card .badge {
  float: right;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 6px;
  background: #444;
  text-align: center;
  line-height: 1.2;
  font-weight: bold;
  color: #eee;
}
.approval-card .card-main { clear: both; }

pre.code-preview {
  background: var(--vscode-editor-background, #1e1e1e);
  border: 1px solid var(--vscode-editorWidget-border, #555);
  border-radius: 10px;
  padding: 10px;
  overflow: auto;
  max-height: 240px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.4;
  margin-top: 8px;
}

.score-banner { display:flex; align-items:center; justify-content:space-between; border-radius:8px; padding:6px 10px; margin-bottom:8px; color:white; font-weight:bold; }
.score-banner .score-value { font-size:18px; margin-right:8px; }
.score-banner.red { background:#8b0000; }
.score-banner.yellow { background:#b8860b; }
.score-banner.orange { background:#d97706; }
.score-banner.green { background:#006400; }

.vector-line { display:flex; gap:12px; margin:6px 0 8px; opacity:.9; font-size:12px; }

.reasons { font-size:12px; color:#bbb; margin:6px 0 10px; line-height:1.35; }
.reasons code { background:rgba(255,255,255,0.08); border-radius:4px; padding:1px 4px; }

.approval-card .actions { margin-top:10px; display:flex; gap:8px; }
.approval-card button { padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-size:13px; }
.approval-card button.approve-btn { background:#0e639c; color:white; }
.approval-card button.reject-btn { background:#333; color:#ddd; }

.approval-card button:focus-visible {
  outline:2px solid #66afe9;
  outline-offset:2px;
}

/* CRAI 구성요소 표 */
.crai-table {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0 10px;
  font-size: 12px;
}
.crai-table th, .crai-table td {
  border: 1px solid #444;
  padding: 4px 6px;
  text-align: center;
}
.crai-table th {
  background: #333;
  color: #eee;
  font-weight: 600;
}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

/* ─────────────────────────────────────────────────────────────────────────────
 * ② 유틸
 * ────────────────────────────────────────────────────────────────────────────*/
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function append(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "user") {
    div.textContent = text;
  } else {
    div.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
  }
  chat.appendChild(div);
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

/* 파일명 힌트 추출 */
function detectSuggestedFileName(fullText, fallbackLang) {
  const re =
    /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*)([A-Za-z0-9_\-./]+?\.[A-Za-z]{1,8})/gi;
  let m, last = null;
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

/* 점수(또는 퍼센트) → 0.0~10.0 변환 */
function toScore10(score) {
  if (typeof score !== "number" || isNaN(score)) return 0;
  const s = score > 10 ? score / 10 : score; // 0~100 → 0~10
  return Math.round(Math.max(0, Math.min(10, s)) * 10) / 10;
}

/* 레벨별 권장 액션 */
function actionFromLevel(level) {
  switch (level) {
    case "CRITICAL": return "Comprehensive audit needed";
    case "HIGH":     return "Detailed review required";
    case "MEDIUM":   return "Standard review process";
    default:         return "Quick scan sufficient";
  }
}

/* CRAI 표준 경계 */
function labelFromScore10(s10) {
  if (s10 >= 9.0) return { key: "RED", level: "CRITICAL", severity: "red", action: actionFromLevel("CRITICAL") };
  if (s10 >= 7.0) return { key: "ORANGE", level: "HIGH", severity: "orange", action: actionFromLevel("HIGH") };
  if (s10 >= 4.0) return { key: "YELLOW", level: "MEDIUM", severity: "yellow", action: actionFromLevel("MEDIUM") };
  return { key: "GREEN", level: "LOW", severity: "green", action: actionFromLevel("LOW") };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ③ 승인 카드 렌더링
 * ────────────────────────────────────────────────────────────────────────────*/
function renderApprovalCard(snippet, analysis) {
  const { language, code } = snippet;
  const filename = snippet.filename || null;

  // 점수/등급 계산
  const scoreRaw = typeof analysis?.score === "number" ? analysis.score : 0;
  const score10 = typeof analysis?.score10 === "number" ? analysis.score10 : toScore10(scoreRaw);
  const label = (analysis?.level && analysis?.severity)
    ? {
        key: analysis.level === "CRITICAL" ? "RED" : analysis.level === "HIGH" ? "ORANGE" : analysis.level === "MEDIUM" ? "YELLOW" : "GREEN",
        level: analysis.level,
        severity: analysis.severity,
        action: actionFromLevel(analysis.level)
      }
    : labelFromScore10(score10);

  // [F,R,D] 0..1
  const vector = Array.isArray(analysis?.vector) ? analysis.vector : null;
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const fmtPct = (x) => Math.round(clamp01(x) * 100);
  const F = vector ? fmtPct(vector[0]) : null;
  const R = vector ? fmtPct(vector[1]) : null;
  const D = vector ? fmtPct(vector[2]) : null;

  // fallback reasons
  const reasons = analysis?.reasons || null;

  // CRAI 구성요소 표용 데이터
  const comp = analysis?.crai_components || null;

  const card = document.createElement("div");
  card.className = "approval-card";
  card.innerHTML = `
    <div class="badge">REVIEW<br/>Required</div>
    <div class="card-main">
      <div class="score-banner ${label.severity}">
        <div class="score-value">${score10.toFixed(1)} / 10</div>
        <div class="score-label">${label.level}</div>
      </div>

      ${
        vector
          ? `<div class="vector-line">
              <span>F ${F}%</span>
              <span>R ${R}%</span>
              <span>D ${D}%</span>
            </div>`
          : ""
      }

      ${
        comp
          ? `<h4>CRAI components</h4>
             <table class="crai-table">
               <tr><th>B</th><th>C</th><th>α</th><th>ρ</th><th>SF</th><th>SR</th><th>SD</th></tr>
               <tr>
                 <td>${toFixedOrDash(comp.B, 2)}</td>
                 <td>${toFixedOrDash(comp.C, 2)}</td>
                 <td>${toFixedOrDash(comp.alpha, 3)}</td>
                 <td>${toFixedOrDash(comp.rho, 3)}</td>
                 <td>${toFixedOrDash(comp.SF, 2)}</td>
                 <td>${toFixedOrDash(comp.SR, 2)}</td>
                 <td>${toFixedOrDash(comp.SD, 2)}</td>
               </tr>
             </table>`
          : ""
      }

      ${
        reasons && Object.keys(reasons).length
          ? `<div class="reasons"><strong>Fallback Reasons:</strong>
               <ul>${Object.entries(reasons)
                 .map(([k,v]) => `<li><code>${escapeHtml(k)}</code>: ${escapeHtml(v)}</li>`)
                 .join("")}</ul>
             </div>`
          : ""
      }

      <h3>Generated Code Review</h3>
      <ul class="meta">
        <li>Language: ${escapeHtml(language || "plaintext")}</li>
        <li>Length: ${code.length} chars</li>
        ${filename ? `<li>Suggested filename: ${escapeHtml(filename)}</li>` : ""}
      </ul>

      <pre class="code-preview"><code>${escapeHtml(code.slice(0, 1200))}${
        code.length > 1200 ? "\n... (truncated)" : ""
      }</code></pre>

      <div class="actions">
        <button class="approve-btn">Approve</button>
        <button class="reject-btn">Reject</button>
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
      score: score10,          // 10점 스케일
      severity: label.severity // green/yellow/orange/red
    });
  });

  card.querySelector(".reject-btn")?.addEventListener("click", () => {
    vscode.postMessage({
      type: "reject",
      code,
      language,
      filename,
      score: score10,
      severity: label.severity
    });
  });
}

function toFixedOrDash(v, n=2){
  const x = Number(v);
  return isFinite(x) ? x.toFixed(n) : "—";
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ④ 마크다운 렌더러 (경량, 코드펜스 + 텍스트)
 * ────────────────────────────────────────────────────────────────────────────*/
function renderMarkdown(md = "") {
  // 코드펜스 파싱: ```lang\n...\n```
  const parts = [];
  let idx = 0;
  const re = /```([a-zA-Z0-9+#._-]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    parts.push({ t: "text", v: md.slice(idx, m.index) });
    parts.push({ t: "code", lang: (m[1] || "plaintext").trim(), v: m[2] });
    idx = m.index + m[0].length;
  }
  parts.push({ t: "text", v: md.slice(idx) });

  // 텍스트 렌더
  const renderText = (s) => {
    let x = escapeHtml(s);
    x = x.replace(/^\s*\*\*([A-Za-z가-힣0-9 _-]+)\*\*\s*$/gm, "<h3>$1</h3>")
         .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
         .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
         .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
         .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
         .replace(/`([^`]+?)`/g, "<code>$1</code>");
    x = x.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("");
    return x;
  };

  const renderCode = (lang, code) => {
    const safe = escapeHtml(code);
    const id = "copy_" + Math.random().toString(36).slice(2);
    return `
      <div class="fence-title">${lang.toUpperCase()}</div>
      <div class="codebox">
        <button class="copy" data-target="${id}">Copy</button>
        <pre id="${id}"><code class="lang-${lang}">${safe}</code></pre>
      </div>`;
  };

  let html = "";
  for (const seg of parts) {
    html += seg.t === "text" ? renderText(seg.v) : renderCode(seg.lang, seg.v);
  }
  return html;
}

// 코드블록 Copy 버튼 위임
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const id = btn.getAttribute("data-target");
  const pre = id && document.getElementById(id);
  if (!pre) return;
  const text = pre.innerText;
  navigator.clipboard?.writeText(text).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 900);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * ⑤ 채팅 스트리밍 UI: 마크다운으로 실시간 렌더 + 히스토리 관리
 * ────────────────────────────────────────────────────────────────────────────*/
let botDiv = null;
let lastBotBuffer = "";

// 새 봇 라인 시작 (마크다운 컨테이너)
function startBotLine() {
  botDiv = document.createElement("div");
  botDiv.className = "msg bot";
  botDiv.innerHTML = '<div class="md"></div>';
  chat.appendChild(botDiv);
  chat.scrollTop = chat.scrollHeight;
}

// 메시지 수신
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg) return;

  if (msg.type === "delta") {
    if (!botDiv) startBotLine();
    lastBotBuffer += (msg.text || "");
    // 마크다운으로 재렌더
    const md = botDiv.querySelector(".md");
    if (md) md.innerHTML = renderMarkdown(lastBotBuffer);
    chat.scrollTop = chat.scrollHeight;
    return;
  }

  if (msg.type === "analysis") {
    // 확장에서 전달: { vector, score, severity, level, suggestedFilename, language, code, reasons, crai_components?, breakdown? }
    const scoreField = typeof msg.score10 === "number" ? msg.score10 : toScore10(msg.score);

    // CRAI 구성요소는 여러 구조를 허용: 최상위 또는 breakdown.fused 내부.
    const craiComponents =
      msg.crai_components ||
      (msg.breakdown && msg.breakdown.fused && msg.breakdown.fused.crai_components) ||
      null;

    window.__lastAnalysis = {
      vector: msg.vector,
      score: scoreField,         // 10점 스케일 유지
      severity: msg.severity || null,
      score10: scoreField,
      level: msg.level || null,
      suggestedFilename: msg.suggestedFilename || null,
      language: msg.language,
      code: msg.code,
      reasons: msg.reasons || {},            // fallback 이유 포함
      crai_components: craiComponents || null
    };
    return;
  }

  if (msg.type === "done") {
    // 스트림 종료 → 승인 카드 렌더
    const snippet = extractLastCodeBlock(lastBotBuffer);
    if (snippet && snippet.code && snippet.code.trim().length > 0) {
      const hint = detectSuggestedFileName(
        lastBotBuffer,
        snippet.language === "plaintext" ? "" : snippet.language
      );
      const analysis = window.__lastAnalysis || null;

      // 분석에서 제안된 파일명이 있으면 우선 사용
      snippet.filename = (analysis && analysis.suggestedFilename) ? analysis.suggestedFilename : (hint || null);

      renderApprovalCard({ ...snippet }, analysis || { score: 0, vector: [0,0,0] });
    }

    // 어시스턴트 응답을 히스토리에 저장 (맥락 유지)
    if (lastBotBuffer?.trim()) {
      history.push({ role: "assistant", content: lastBotBuffer });
    }

    // 다음 턴 초기화
    botDiv = null;
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

  // 사용자 메시지를 UI와 히스토리에 기록
  append("user", text);
  history.push({ role: "user", content: text }); // 히스토리 추가

  // 확장 쪽으로 질문 + 히스토리 전달
  vscode.postMessage({
    type: "ask",
    text,
    history, // 최근 맥락을 함께 보냄
  });

  input.value = "";
  startBotLine();
  lastBotBuffer = "";
  window.__lastAnalysis = null;
});
