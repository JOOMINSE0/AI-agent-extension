/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

// 안전 가드
if (!chat || !form || !input) {
  console.error("webview DOM not ready: missing #chat/#composer/#prompt");
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ① 모달/채팅용 스타일 주입
 * ────────────────────────────────────────────────────────────────────────────*/
// --- 모달 기본 스타일(기존) ---
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
  width: 920px;
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
  position: relative;
}
.analysis-modal h2 { margin:0 0 8px 0; font-size:18px; }
.analysis-modal .kpi { display:flex; gap:12px; align-items:center; margin-bottom:12px; }
.analysis-modal .kpi .big { font-weight:700; font-size:28px; padding:8px 12px; border-radius:6px; }
.analysis-modal .kpi .green { background:#1e7a2d; color:white; }
.analysis-modal .kpi .yellow { background:#b8860b; color:white; }
.analysis-modal .kpi .orange { background:#d9822b; color:white; } /* ✅ ORANGE */
.analysis-modal .kpi .red { background:#b31c1c; color:white; }
.analysis-modal .vector-row { display:flex; gap:16px; margin-bottom:8px; }
.analysis-modal .vector-row .item { min-width:120px; }
.analysis-modal .section { margin-top:12px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06); }
.analysis-modal .reasons { margin-top:8px; }
.analysis-modal pre { background: rgba(0,0,0,0.2); padding:10px; border-radius:6px; overflow:auto; white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size:12px; }
.analysis-modal .close-btn { position:absolute; right:18px; top:14px; background:transparent; border:0; color:inherit; cursor:pointer; font-size:18px; }
.analysis-modal .footer { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
.analysis-modal .explain { font-size:13px; color:var(--vscode-descriptionForeground,#cfcfcf); }
.signal-grid { display:grid; grid-template-columns: 210px 1fr 1fr; gap:6px 12px; margin-top:6px; font-size:12px; }
.signal-grid .th { opacity:0.8; }
.badge-mini { display:inline-block; padding:2px 6px; border-radius:10px; background:#333; color:#ddd; font-size:11px; margin-left:6px; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

// --- 채팅 마크다운 가독성 스타일(신규) ---
(function injectChatMdStyles() {
  const css = `
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

/* 승인 카드 등 기존 컴포넌트 일부(요약) */
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
.approval-card .actions { margin-top:10px; display:flex; gap:8px; }
.approval-card button { padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-size:13px; }
.approval-card button.approve-btn { background:#0e639c; color:white; }
.approval-card button.reject-btn { background:#333; color:#ddd; }
.approval-card button.details-btn { background:transparent; border:1px solid #777; color:#ccc; }
.vector-line { display:flex; gap:12px; margin:6px 0 8px; opacity:.9; font-size:12px; }
.reasons { font-size:12px; color:#bbb; margin-bottom:8px; line-height:1.35; }
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
  // 사용자 메시지는 단순 텍스트로
  if (role === "user") {
    div.textContent = text;
  } else {
    // 봇 메시지는 마크다운 렌더 결과로
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

/**
 * 파일명 힌트 추출 (강화판)
 */
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

/**
 * 점수(0~100 또는 0~10 정수) → 0.0~10.0 변환
 */
function toScore10(score) {
  if (typeof score !== "number" || isNaN(score)) return 0;
  // 이미 0~10 범위면 그대로, 0~100이면 10으로 나눔
  const s = score > 10 ? score / 10 : score;
  const s10 = Math.round(Math.max(0, Math.min(10, s)) * 10) / 10; // 소수 1자리
  return s10;
}

/**
 * 레벨별 권장 액션
 */
function actionFromLevel(level) {
  switch (level) {
    case "CRITICAL": return "Comprehensive audit needed";
    case "HIGH":     return "Detailed review required";
    case "MEDIUM":   return "Standard review process";
    default:         return "Quick scan sufficient";
  }
}

/**
 * CRAI 표준 경계로 색상/등급 산출 (0.0~10.0)
 * 0.0–3.9 LOW/Green, 4.0–6.9 MEDIUM/Yellow, 7.0–8.9 HIGH/Orange, 9.0–10.0 CRITICAL/Red
 */
function labelFromScore10(s10) {
  if (s10 >= 9.0) return { key: "RED", level: "CRITICAL", severity: "red", action: actionFromLevel("CRITICAL") };
  if (s10 >= 7.0) return { key: "ORANGE", level: "HIGH", severity: "orange", action: actionFromLevel("HIGH") };
  if (s10 >= 4.0) return { key: "YELLOW", level: "MEDIUM", severity: "yellow", action: actionFromLevel("MEDIUM") };
  return { key: "GREEN", level: "LOW", severity: "green", action: actionFromLevel("LOW") };
}

/**
 * 신호 테이블 렌더링 (analysis.signalTable + 최상위 가중치)
 */
function renderSignalTable(signalTable, topWeights) {
  if (!signalTable) return '<div class="explain">No signal values provided.</div>';

  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0)); // ✅ 0~1 클램프
  const pct = (x) => `${Math.round(clamp01(x) * 100)}%`;
  const rows = [];

  // F
  if (signalTable.F) {
    rows.push(
      `<div class="th"><strong>F · Functionality</strong>${topWeights ? `<span class="badge-mini">wF ${topWeights.wF}</span>` : ""}</div><div class="th">Value (0–1)</div><div class="th">Notes</div>`,
      `<div>Changed API Ratio</div><div>${clamp01(signalTable.F.changedApiRatio).toFixed(2)}</div><div>${pct(signalTable.F.changedApiRatio)}</div>`,
      `<div>Core Module Modified</div><div>${clamp01(signalTable.F.coreModuleModified).toFixed(0)}</div><div>core/domain/service</div>`,
      `<div>Code Change Size</div><div>${clamp01(signalTable.F.diffLineRatio).toFixed(2)}</div><div>${pct(signalTable.F.diffLineRatio)}</div>`,
      `<div>Schema Change</div><div>${clamp01(signalTable.F.schemaChanged).toFixed(0)}</div><div>DDL/migration</div>`
    );
  }

  // R
  if (signalTable.R) {
    rows.push(
      `<div class="th" style="margin-top:6px;"><strong>R · Resource/Stability</strong>${topWeights ? `<span class="badge-mini">wR ${topWeights.wR}</span>` : ""}</div><div class="th">Value (0–1)</div><div class="th">Notes</div>`,
      `<div>Algorithm Complexity</div><div>${clamp01(signalTable.R.timeComplexity).toFixed(2)}</div><div>Big-O mapping</div>`,
      `<div>Memory Allocation Increase</div><div>${clamp01(signalTable.R.memIncreaseRatio).toFixed(2)}</div><div>${pct(signalTable.R.memIncreaseRatio)}</div>`,
      `<div>External Call Addition</div><div>${clamp01(signalTable.R.externalCallNorm).toFixed(2)}</div><div>Latency/cost normalization</div>`
    );
  }

  // D
  if (signalTable.D) {
    rows.push(
      `<div class="th" style="margin-top:6px;"><strong>D · Dependency/Security</strong>${topWeights ? `<span class="badge-mini">wD ${topWeights.wD}</span>` : ""}</div><div class="th">Value (0–1)</div><div class="th">Notes</div>`,
      `<div>CVE Severity</div><div>${clamp01(signalTable.D.cveSeverity).toFixed(2)}</div><div>0–1</div>`,
      `<div>Library Reputation</div><div>${clamp01(signalTable.D.libReputation).toFixed(2)}</div><div>Higher is safer</div>`,
      `<div>License Mismatch</div><div>${clamp01(signalTable.D.licenseMismatch).toFixed(0)}</div><div>0/1</div>`,
      `<div>Sensitive Permission</div><div>${clamp01(signalTable.D.sensitivePerm).toFixed(2)}</div><div>0–1</div>`
    );
  }

  return `<div class="signal-grid">${rows.join("")}</div>`;
}

/**
 * 상세 모달 표시
 * - analysis: { score, score10?, severity?, level?, vector, reasons, breakdown?, signalTable?, weights? }
 * - snippet: { language, code, filename }
 */
function showAnalysisModal(analysis = {}, snippet = {}) {
  if (document.querySelector(".analysis-modal-overlay")) return;

  // 최종 점수(10점 스케일)과 라벨 결정
  const scoreRaw = typeof analysis.score === "number" ? analysis.score : 0;
  const score10 = typeof analysis.score10 === "number" ? analysis.score10 : toScore10(scoreRaw);
  const label = (analysis.level && analysis.severity)
    ? { key: analysis.level === "CRITICAL" ? "RED" : analysis.level === "HIGH" ? "ORANGE" : analysis.level === "MEDIUM" ? "YELLOW" : "GREEN",
        level: analysis.level,
        severity: analysis.severity,
        action: actionFromLevel(analysis.level) }
    : labelFromScore10(score10);

  // F/R/D 벡터
  const fusedVector = Array.isArray(analysis.vector) ? analysis.vector : [0, 0, 0];
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const pctNum = (x) => Math.round(clamp01(x) * 100);
  const F = pctNum(fusedVector[0]);
  const R = pctNum(fusedVector[1]);
  const D = pctNum(fusedVector[2]);

  const reasons = analysis.reasons || {};
  const signalTable = analysis.signalTable || null;
  const topWeights = analysis.weights || null;

  // 분해 점수(있을 때만 렌더)
  const bd = analysis.breakdown || {};
  const mkRow = (labelText, entry) => {
    if (!entry || !Array.isArray(entry.vector)) return "";
    const v = entry.vector;
    const _F = pctNum(v[0]), _R = pctNum(v[1]), _D = pctNum(v[2]);
    const s10 = typeof entry.score === "number" ? toScore10(entry.score) : null;
    const sev = (entry.severity || "").toUpperCase();
    return `
      <div style="display:flex;gap:12px;align-items:center;margin:4px 0;">
        <div style="min-width:120px;"><strong>${labelText}</strong></div>
        <div style="min-width:110px;">Score: ${s10 !== null ? s10.toFixed(1) + ' / 10' : "-"}</div>
        <div style="min-width:110px;">Level: ${sev}</div>
        <div>F ${_F}% / R ${_R}% / D ${_D}%</div>
      </div>`;
  };

  const overlay = document.createElement("div");
  overlay.className = "analysis-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "analysis-modal";

  modal.innerHTML = `
    <button class="close-btn" title="Close">&times;</button>
    <h2>Approval Analysis Details</h2>

    <div class="kpi">
      <div class="big ${label.severity}">${score10.toFixed(1)} / 10</div>
      <div style="flex:1">
        <div style="font-weight:700">
          ${label.level} — ${label.action}
        </div>
        <div class="explain">
          The headline represents the final fused score (FUSED).
          ${topWeights ? `<span class="badge-mini">Weights F:${topWeights.wF} R:${topWeights.wR} D:${topWeights.wD}</span>` : ""}
        </div>
      </div>
    </div>

    <div class="vector-row">
      <div class="item"><strong>F (Functionality)</strong><div>${F}%</div></div>
      <div class="item"><strong>R (Resource/Stability)</strong><div>${R}%</div></div>
      <div class="item"><strong>D (Dependency/Security)</strong><div>${D}%</div></div>
    </div>

    <div class="section">
      <div style="font-weight:700">Decomposed Scores (Reference)</div>
      ${mkRow("Fused", bd.fused)}
      ${mkRow("LLM-only", bd.llmOnly)}
      ${mkRow("Heuristic-only", bd.heurOnly)}
      ${(!bd.fused && !bd.llmOnly && !bd.heurOnly) ? '<div class="explain">No additional decomposed scores available.</div>' : ''}
    </div>

    <div class="section">
      <div style="font-weight:700">Rationale (LLM & Heuristics)</div>
      <div class="reasons">
        ${reasons.function_change ? `<div><strong>Function Change:</strong> ${escapeHtml(reasons.function_change)}</div>` : ""}
        ${reasons.resource_usage ? `<div><strong>Resource Usage:</strong> ${escapeHtml(reasons.resource_usage)}</div>` : ""}
        ${reasons.security_dependency ? `<div><strong>Security/Dependency:</strong> ${escapeHtml(reasons.security_dependency)}</div>` : ""}
        ${(!reasons.function_change && !reasons.resource_usage && !reasons.security_dependency) ? `<div class="explain">No additional explanation provided.</div>` : ""}
      </div>
    </div>

    <div class="section">
      <div style="font-weight:700">Code Snippet</div>
      <div class="explain">Suggested filename: ${escapeHtml(snippet.filename || "(none)")}</div>
      <pre>${escapeHtml((snippet.code || "").slice(0, 2000))}${(snippet.code && snippet.code.length>2000) ? "\n... (truncated)" : ""}</pre>
    </div>

    <div class="footer">
      <button class="close-btn primary"></button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function removeModal() {
    try { overlay.remove(); } catch { /* ignore */ }
    window.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") removeModal(); }

  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) removeModal(); });
  modal.querySelectorAll(".close-btn").forEach(btn => btn.addEventListener("click", removeModal));
  window.addEventListener("keydown", onKey);
}

/**
 * 승인 카드 렌더링
 * - CRAI 표준(0.0–10.0) 경계 적용 (LOW/MEDIUM/HIGH/CRITICAL)
 * - 카드 상단에 점수(소수 1자리)와 레벨 표기
 */
function renderApprovalCard(snippet, analysis) {
  const { language, code } = snippet;
  const filename = snippet.filename || null;

  // 점수/등급 계산
  const scoreRaw = typeof analysis?.score === "number" ? analysis.score : 0;
  const score10 = typeof analysis?.score10 === "number" ? analysis.score10 : toScore10(scoreRaw);
  const label = (analysis?.level && analysis?.severity)
    ? { key: analysis.level === "CRITICAL" ? "RED" : analysis.level === "HIGH" ? "ORANGE" : analysis.level === "MEDIUM" ? "YELLOW" : "GREEN",
        level: analysis.level, severity: analysis.severity, action: actionFromLevel(analysis.level) }
    : labelFromScore10(score10);

  const vector = Array.isArray(analysis?.vector) ? analysis.vector : null; // [F,R,D] 0..1
  const reasons = analysis?.reasons || {};

  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const fmtPct = (x) => Math.round(clamp01(x) * 100);
  const F = vector ? fmtPct(vector[0]) : null;
  const R = vector ? fmtPct(vector[1]) : null;
  const D = vector ? fmtPct(vector[2]) : null;

  const card = document.createElement("div");
  card.className = "approval-card critical";
  card.innerHTML = `
    <div class="badge">REVIEW<br/>Required</div>
    <div class="card-main">
      <div class="score-banner ${label.severity}">
        <div class="score-value">${score10.toFixed(1)} / 10</div>
        <div class="score-label">${label.level}</div>
      </div>

      ${
        vector
          ? `<div class="vector-line" style="display:flex;gap:12px;margin-bottom:8px;">
              <span>F ${F}%</span>
              <span>R ${R}%</span>
              <span>D ${D}%</span>
            </div>`
          : ""
      }

      ${
        (reasons.function_change || reasons.resource_usage || reasons.security_dependency)
          ? `<div class="reasons">
              ${reasons.function_change ? `<div>Function Change: ${escapeHtml(reasons.function_change)}</div>` : ""}
              ${reasons.resource_usage ? `<div>Resource Usage: ${escapeHtml(reasons.resource_usage)}</div>` : ""}
              ${reasons.security_dependency ? `<div>Security/Dependency: ${escapeHtml(reasons.security_dependency)}</div>` : ""}
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
        <button class="reject-btn ghost">Reject</button>
        <button class="details-btn outline">View Details</button>
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
      score: score10,                 // 10점 스케일 전달
      severity: label.severity        // green/yellow/orange/red
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

  // 자세히 보기: analysis + snippet을 모달로 보여줌
  card.querySelector(".details-btn")?.addEventListener("click", () => {
    const a = analysis || { vector: vector || [0,0,0], score: score10, severity: label.severity, level: label.level, score10 };
    showAnalysisModal(a, { language: language, code: code, filename: filename });
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ③ 마크다운 렌더러 (경량, 코드펜스 + 텍스트)
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

  // 텍스트 렌더: 헤딩/볼드/인라인코드/문단
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
 * ④ 채팅 스트리밍 UI: 마크다운으로 실시간 렌더
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
    // 확장에서 전달: { vector, score, severity?, score10?, level?, suggestedFilename, language, code, reasons?, breakdown?, signalTable?, weights? }
    const scoreField = typeof msg.score10 === "number" ? msg.score10 : toScore10(msg.score);
    window.__lastAnalysis = {
      vector: msg.vector,
      score: scoreField,               // 내부적으로도 10점 스케일 유지
      severity: msg.severity || null,
      score10: scoreField,
      level: msg.level || null,
      suggestedFilename: msg.suggestedFilename,
      language: msg.language,
      code: msg.code,
      reasons: msg.reasons || {},
      breakdown: msg.breakdown || null,
      signalTable: msg.signalTable || null,
      weights: msg.weights || null
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
      if (analysis && analysis.suggestedFilename) {
        snippet.filename = analysis.suggestedFilename;
      } else {
        snippet.filename = hint || null;
      }

      renderApprovalCard({ ...snippet }, analysis);
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

  append("user", text);
  vscode.postMessage({ type: "ask", text });

  input.value = "";
  startBotLine();
  lastBotBuffer = "";
  window.__lastAnalysis = null;
});
