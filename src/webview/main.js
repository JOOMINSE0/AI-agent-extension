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
.analysis-modal .kpi .orange { background:#d9822b; color:white; } /* ✅ ORANGE 추가 */
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
 * 점수(0~100) → 0.0~10.0 변환
 */
function toScore10(score) {
  if (typeof score !== "number" || isNaN(score)) return 0;
  const s10 = score / 10;
  return Math.max(0, Math.min(10, s10));
}

/**
 * CRAI 표준 경계로 색상/등급 산출 (0.0~10.0)
 */
function labelFromScore10(s10) {
  if (s10 >= 9.0) return { key: "RED", level: "CRITICAL", severity: "red" };
  if (s10 >= 7.0) return { key: "ORANGE", level: "HIGH", severity: "orange" };
  if (s10 >= 4.0) return { key: "YELLOW", level: "MEDIUM", severity: "yellow" };
  return { key: "GREEN", level: "LOW", severity: "green" };
}

/**
 * 신호 테이블 렌더링 (analysis.signalTable + 최상위 가중치)
 */
function renderSignalTable(signalTable, topWeights) {
  if (!signalTable) return '<div class="explain">신호값이 제공되지 않았습니다.</div>';

  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0)); // ✅ 0~1 클램프
  const pct = (x) => `${Math.round(clamp01(x) * 100)}%`;
  const rows = [];

  // F
  if (signalTable.F) {
    rows.push(
      `<div class="th"><strong>F · 기능 변경</strong>${topWeights ? `<span class="badge-mini">wF ${topWeights.wF}</span>` : ""}</div><div class="th">값(0~1)</div><div class="th">비고</div>`,
      `<div>Changed API Ratio</div><div>${clamp01(signalTable.F.changedApiRatio).toFixed(2)}</div><div>${pct(signalTable.F.changedApiRatio)}</div>`,
      `<div>Core Module Modified</div><div>${clamp01(signalTable.F.coreModuleModified).toFixed(0)}</div><div>core/domain/service</div>`,
      `<div>Code Change Size</div><div>${clamp01(signalTable.F.diffLineRatio).toFixed(2)}</div><div>${pct(signalTable.F.diffLineRatio)}</div>`,
      `<div>Schema Change</div><div>${clamp01(signalTable.F.schemaChanged).toFixed(0)}</div><div>DDL/migration</div>`
    );
  }

  // R
  if (signalTable.R) {
    rows.push(
      `<div class="th" style="margin-top:6px;"><strong>R · 자원/안정성</strong>${topWeights ? `<span class="badge-mini">wR ${topWeights.wR}</span>` : ""}</div><div class="th">값(0~1)</div><div class="th">비고</div>`,
      `<div>Algorithm Complexity</div><div>${clamp01(signalTable.R.timeComplexity).toFixed(2)}</div><div>Big-O 매핑</div>`,
      `<div>Memory Allocation Increase</div><div>${clamp01(signalTable.R.memIncreaseRatio).toFixed(2)}</div><div>${pct(signalTable.R.memIncreaseRatio)}</div>`,
      `<div>External Call Addition</div><div>${clamp01(signalTable.R.externalCallNorm).toFixed(2)}</div><div>지연/비용 정규화</div>`
    );
  }

  // D
  if (signalTable.D) {
    rows.push(
      `<div class="th" style="margin-top:6px;"><strong>D · 보안/의존성</strong>${topWeights ? `<span class="badge-mini">wD ${topWeights.wD}</span>` : ""}</div><div class="th">값(0~1)</div><div class="th">비고</div>`,
      `<div>CVE Severity</div><div>${clamp01(signalTable.D.cveSeverity).toFixed(2)}</div><div>0~1</div>`,
      `<div>Library Reputation</div><div>${clamp01(signalTable.D.libReputation).toFixed(2)}</div><div>높을수록 안전</div>`,
      `<div>License Mismatch</div><div>${clamp01(signalTable.D.licenseMismatch).toFixed(0)}</div><div>0/1</div>`,
      `<div>Sensitive Permission</div><div>${clamp01(signalTable.D.sensitivePerm).toFixed(2)}</div><div>0~1</div>`
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

  // 헤드라인(최종/FUSED)
  const headScore = typeof analysis.score === "number" ? analysis.score : 0;
  const score10 = typeof analysis.score10 === "number" ? analysis.score10 : toScore10(headScore);
  const label = analysis.level && analysis.severity
    ? { key: analysis.level === "CRITICAL" ? "RED" : analysis.level === "HIGH" ? "ORANGE" : analysis.level === "MEDIUM" ? "YELLOW" : "GREEN",
        level: analysis.level,
        severity: analysis.severity }
    : labelFromScore10(score10); // ✅ 확장 미지원 시 자체 계산

  // F/R/D 벡터(기본: FUSED)
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
    return `
      <div style="display:flex;gap:12px;align-items:center;margin:4px 0;">
        <div style="min-width:120px;"><strong>${labelText}</strong></div>
        <div style="min-width:70px;">점수: ${typeof entry.score==='number' ? entry.score : "-"}</div>
        <div style="min-width:80px;">등급: ${(entry.severity||"").toUpperCase()}</div>
        <div>F ${_F}% / R ${_R}% / D ${_D}%</div>
      </div>`;
  };

  const overlay = document.createElement("div");
  overlay.className = "analysis-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "analysis-modal";

  modal.innerHTML = `
    <button class="close-btn" title="Close">&times;</button>
    <h2>승인 상세 분석 결과</h2>

    <div class="kpi">
      <div class="big ${label.severity}">${headScore}</div>
      <div style="flex:1">
        <div style="font-weight:700">
          ${label.severity==='red' ? '승인 필수 (Human review required)'
            : label.severity==='orange' ? '상세 검토 필요 (Detailed review required)'
            : label.severity==='yellow' ? '승인 필요'
            : '안전 (자동 승인 가능)'}
        </div>
        <div class="explain">
          헤드라인은 최종 융합 점수(FUSED)를 그대로 표시합니다.
          ${topWeights ? `<span class="badge-mini">Weights F:${topWeights.wF} R:${topWeights.wR} D:${topWeights.wD}</span>` : ""}
        </div>
      </div>
    </div>

    <div class="vector-row">
      <div class="item"><strong>F (기능 변경)</strong><div>${F}%</div></div>
      <div class="item"><strong>R (자원/안정성)</strong><div>${R}%</div></div>
      <div class="item"><strong>D (보안/의존성)</strong><div>${D}%</div></div>
    </div>

    <div class="section">
      <div style="font-weight:700">분해 점수(참고)</div>
      ${mkRow("Fused(결정값)", bd.fused)}
      ${mkRow("LLM-only", bd.llmOnly)}
      ${mkRow("Heuristic-only", bd.heurOnly)}
      ${(!bd.fused && !bd.llmOnly && !bd.heurOnly) ? '<div class="explain">추가 분해 점수가 제공되지 않았습니다.</div>' : ''}
    </div>

    <div class="section">
      <div style="font-weight:700">취약점/판단 근거 (LLM/휴리스틱)</div>
      <div class="reasons">
        ${reasons.function_change ? `<div><strong>기능변경:</strong> ${escapeHtml(reasons.function_change)}</div>` : ""}
        ${reasons.resource_usage ? `<div><strong>자원/안정성:</strong> ${escapeHtml(reasons.resource_usage)}</div>` : ""}
        ${reasons.security_dependency ? `<div><strong>보안/의존성:</strong> ${escapeHtml(reasons.security_dependency)}</div>` : ""}
        ${(!reasons.function_change && !reasons.resource_usage && !reasons.security_dependency) ? `<div class="explain">추가 설명이 없습니다.</div>` : ""}
      </div>
    </div>

    <div class="section">
      <div style="font-weight:700">관련 코드 스니펫</div>
      <div class="explain">파일명 제안: ${escapeHtml(snippet.filename || "(없음)")}</div>
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
 * - analysis.score / analysis.severity(미존재 가능) / analysis.vector / analysis.reasons 반영
 * - CRAI 표준(0.0–10.0) 경계로 오렌지 표시
 */
function renderApprovalCard(snippet, analysis) {
  const { language, code } = snippet;
  const filename = snippet.filename || null;

  // 점수/등급 계산 (확장에 score10/level이 있으면 그대로, 없으면 score→score10 변환)
  const score = typeof analysis?.score === "number" ? analysis.score : null;
  const score10 = typeof analysis?.score10 === "number" ? analysis.score10 : toScore10(score || 0);
  const label = (analysis?.level && analysis?.severity)
    ? { key: analysis.level === "CRITICAL" ? "RED" : analysis.level === "HIGH" ? "ORANGE" : analysis.level === "MEDIUM" ? "YELLOW" : "GREEN",
        level: analysis.level, severity: analysis.severity }
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
    <div class="badge">REVIEW<br/>승인 필요</div>
    <div class="card-main">
      <div class="score-banner ${label.severity}">
        <div class="score-value">${score ?? ""}</div>
        <div class="score-label">${label.key}</div>
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
              ${reasons.function_change ? `<div>기능변경: ${escapeHtml(reasons.function_change)}</div>` : ""}
              ${reasons.resource_usage ? `<div>자원/안정성: ${escapeHtml(reasons.resource_usage)}</div>` : ""}
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
      severity: label.severity //  orange/red/yellow/green 중 하나
    });
  });

  card.querySelector(".reject-btn")?.addEventListener("click", () => {
    vscode.postMessage({
      type: "reject",
      code,
      language,
      filename,
      score,
      severity: label.severity
    });
  });

  // 자세히 보기: analysis + snippet을 모달로 보여줌
  card.querySelector(".details-btn")?.addEventListener("click", () => {
    const a = analysis || { vector: vector || [0,0,0], score: score ?? 0, severity: label.severity, level: label.level, score10 };
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
    // 확장에서 전달: { vector, score, severity?, score10?, level?, suggestedFilename, language, code, reasons?, breakdown?, signalTable?, weights? }
    window.__lastAnalysis = {
      vector: msg.vector,
      score: msg.score,
      severity: msg.severity || null,
      score10: typeof msg.score10 === "number" ? msg.score10 : toScore10(msg.score),
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
    append("bot", ` ${msg.message}`);
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
