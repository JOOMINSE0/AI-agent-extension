"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// src/extension.ts
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ts = __importStar(require("typescript"));
/**
 * AI Approval Agent (CRAI 식 적용 + 정적 분석 기반 SF/SR/SD 산출)
 *
 * 핵심:
 *  - CVE.org JSON에서 생성된 "정규식 룰 DB(generated_cve_rules.json)" + "벡터 DB(generated_cve_db.json)"
 *    를 동적으로 로딩하여 실제 데이터 기반 위험도(CVE) 점수를 계산.
 *  - 고정 vocab/하드코딩 삭제. 코사인(벡터)와 정규식 휴리스틱(룰 DB)을 모두 JSON에서만 읽어 사용.
 *  - DB가 없으면 해당 점수는 0으로 처리(동작은 유지, 로그 경고).
 *  - SF(Functionality)는 키워드 매칭이 아닌 의미 기반(AST→호출그래프) 영향도로 계산하며,
 *    TS/JS에서 우선 적용, 기타 언어는 기존 방식으로 폴백.
 */
// ─────────────────────────────────────────────────────────────────────────────
// 0) 확장 활성화
// ─────────────────────────────────────────────────────────────────────────────
function activate(context) {
    console.log("AI Approval Agent is now active!");
    // (1) 정규식 룰 DB (2) CVE 벡터 DB 로드
    RULE_DB = loadGeneratedRuleDb(context);
    if (RULE_DB.length) {
        console.log(`[CVE] Loaded generated RULE DB: ${RULE_DB.length} signature(s)`);
    }
    else {
        console.warn("[CVE] WARNING: generated_cve_rules.json not found or empty. Regex scoring -> 0");
    }
    DYN_CVE_DB = loadGeneratedCveDb(context);
    if (DYN_CVE_DB.length) {
        console.log(`[CVE] Loaded generated VECTOR DB: ${DYN_CVE_DB.length} signature(s)`);
    }
    else {
        console.warn("[CVE] WARNING: generated_cve_db.json not found or empty. Vector scoring -> 0");
    }
    const provider = new ApprovalViewProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("aiApprovalView", provider, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("ai-approval-agent.showPanel", () => {
        vscode.window.showInformationMessage("AI Approval Panel opened!");
    }));
}
let LAST_SNIPPETS = []; // 가장 최근 Ask로 생성된 코드블록 목록
// ─────────────────────────────────────────────────────────────────────────────
// 1) Webview Provider
// ─────────────────────────────────────────────────────────────────────────────
class ApprovalViewProvider {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    resolveWebviewView(view) {
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "src", "webview")]
        };
        const nonce = getNonce();
        view.webview.html = getHtml(view.webview, this.ctx, nonce);
        wireMessages(view.webview);
    }
}
/* ---------- Config ---------- */
function getCfg() {
    const cfg = vscode.workspace.getConfiguration();
    return {
        endpoint: (cfg.get("aiApproval.ollama.endpoint") || "http://210.110.103.64:11434").replace(/\/$/, ""),
        model: cfg.get("aiApproval.ollama.model") || "llama3.1:8b",
        // FRD weights
        wF: cfg.get("aiApproval.weights.functionality") ?? 0.40,
        wR: cfg.get("aiApproval.weights.resource") ?? 0.30,
        wD: cfg.get("aiApproval.weights.dependency") ?? 0.30
    };
}
/* ---------- Webview messaging ---------- */
function wireMessages(webview) {
    webview.onDidReceiveMessage(async (msg) => {
        try {
            switch (msg.type) {
                case "approve": {
                    const { mode } = msg || {};
                    // RED gate
                    if (msg?.severity === "red") {
                        const input = await vscode.window.showInputBox({
                            prompt: `High risk (${msg?.score}). Type 'CONFIRM' to continue.`,
                            validateInput: (v) => (v === "CONFIRM" ? null : "You must type CONFIRM to proceed.")
                        });
                        if (input !== "CONFIRM")
                            return;
                    }
                    if (mode === "one" || mode === "all") {
                        if (!LAST_SNIPPETS.length) {
                            vscode.window.showWarningMessage("승인할 코드가 없습니다. 먼저 'Ask'로 코드를 생성하세요.");
                            return;
                        }
                        if (mode === "one") {
                            const index = typeof msg.index === "number" ? msg.index : -1;
                            if (index < 0 || index >= LAST_SNIPPETS.length) {
                                vscode.window.showErrorMessage("잘못된 코드블록 인덱스입니다.");
                                return;
                            }
                            const snip = LAST_SNIPPETS[index];
                            await handleApproval(snip.code, snip.language, snip.suggested);
                            break;
                        }
                        if (mode === "all") {
                            await handleApprovalMany(LAST_SNIPPETS);
                            break;
                        }
                    }
                    else {
                        // 레거시: 단일 코드 승인
                        const { code = "", language = "plaintext" } = msg || {};
                        await handleApproval(code, language, null);
                    }
                    break;
                }
                case "reject": {
                    vscode.window.showWarningMessage("Rejected (not saved or executed).");
                    break;
                }
                case "details": {
                    vscode.window.showInformationMessage("View details: the reason is shown on the card.");
                    break;
                }
                case "ask": {
                    const { endpoint, model, wF, wR, wD } = getCfg();
                    try {
                        // 1) 코드 생성 스트리밍
                        const fullText = await chatWithOllamaAndReturn(endpoint, model, msg.text, (delta) => {
                            webview.postMessage({ type: "delta", text: delta });
                        });
                        // 2) 전체 코드블록 추출 + 상태 저장
                        const blocks = extractCodeBlocksTS(fullText);
                        LAST_SNIPPETS = blocks.map((b) => ({
                            language: b.language,
                            code: b.code,
                            suggested: detectSuggestedFileName(b.code, b.language)
                        }));
                        // 3) 대표 블록(마지막)으로 정적 파이프라인 실행
                        const primary = LAST_SNIPPETS.length > 0
                            ? LAST_SNIPPETS[LAST_SNIPPETS.length - 1]
                            : { language: "plaintext", code: "", suggested: null };
                        const globalSuggested = detectSuggestedFileName(fullText, primary.language) || primary.suggested || null;
                        const metrics = await runStaticPipeline(primary.code, globalSuggested, primary.language);
                        // 4) 정적 분석 → FRD → CRAI
                        const heur = analyzeFromStaticMetrics(metrics, globalSuggested);
                        const fusedVector = heur.vector;
                        const scored = scoreFromVector(fusedVector, { wF, wR, wD });
                        // 5) 웹뷰로 전달 (+ DB 경고)
                        const dbWarns = [];
                        if (!RULE_DB.length)
                            dbWarns.push("generated_cve_rules.json not loaded → regex score = 0");
                        if (!DYN_CVE_DB.length)
                            dbWarns.push("generated_cve_db.json not loaded → vector score = 0");
                        webview.postMessage({
                            type: "analysis",
                            vector: fusedVector,
                            score: scored.score,
                            severity: scored.severity,
                            level: scored.level,
                            weights: scored.weights,
                            suggestedFilename: globalSuggested || null,
                            language: primary.language,
                            code: primary.code,
                            reasons: [...heur.reasons, ...dbWarns.map((w) => `warn:${w}`)],
                            crai_components: scored.crai_components,
                            signalTable: heur.signalTable,
                            breakdown: { heurOnly: { vector: heur.vector, ...scored } },
                            blocks: LAST_SNIPPETS.map((b, i) => ({
                                index: i,
                                language: b.language,
                                suggested: b.suggested || null,
                                preview: (b.code || "").split(/\r?\n/, 2).join("\n"),
                                length: b.code.length
                            }))
                        });
                        webview.postMessage({ type: "done" });
                    }
                    catch (e) {
                        const detail = e?.message || String(e);
                        console.error("분석 파이프라인 실패:", e);
                        vscode.window.showErrorMessage(`분석 실패: ${detail}`);
                        webview.postMessage({ type: "error", message: detail });
                    }
                    break;
                }
            }
        }
        catch (e) {
            const detail = e?.message || String(e);
            console.error(detail);
            vscode.window.showErrorMessage(detail);
            webview.postMessage({ type: "error", message: detail });
        }
    });
}
/* ---------- Ollama chat (stream + return full text) ---------- */
async function chatWithOllamaAndReturn(endpoint, model, userText, onDelta) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchFn = globalThis.fetch;
    if (!fetchFn)
        return ""; // 네트워크 불가 환경에서도 UI가 깨지지 않도록
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
    if (!res.ok || !res.body)
        return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let full = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line)
                continue;
            try {
                const obj = JSON.parse(line);
                const piece = obj?.message?.content || "";
                if (piece) {
                    full += piece;
                    onDelta(piece);
                }
            }
            catch {
                /* ignore partial */
            }
        }
    }
    return full;
}
/** 동적 로드된 DB들 */
let RULE_DB = []; // generated_cve_rules.json
let DYN_CVE_DB = []; // generated_cve_db.json
/** generated_cve_rules.json 로드 함수 */
function loadGeneratedRuleDb(ctx) {
    try {
        const base = ctx ? ctx.extensionUri.fsPath : process.cwd();
        const p = path.join(base, "cve_data", "generated_cve_rules.json");
        if (!fs.existsSync(p))
            return [];
        const raw = fs.readFileSync(p, "utf8");
        const obj = JSON.parse(raw);
        const arr = obj?.signatures;
        // NOTE: 루트에 tokenizer_rules가 있을 수 있으므로 RULE_DB를 any로 볼 때 접근
        RULE_DB = arr || [];
        RULE_DB.tokenizer_rules = obj?.tokenizer_rules || [];
        return Array.isArray(arr) ? arr : [];
    }
    catch (e) {
        console.error("[CVE] loadGeneratedRuleDb error:", e);
        return [];
    }
}
/** generated_cve_db.json 로드 함수 (벡터) */
function loadGeneratedCveDb(ctx) {
    try {
        const base = ctx ? ctx.extensionUri.fsPath : process.cwd();
        const p = path.join(base, "cve_data", "generated_cve_db.json");
        if (!fs.existsSync(p))
            return [];
        const raw = fs.readFileSync(p, "utf8");
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    }
    catch (e) {
        console.error("[CVE] loadGeneratedCveDb error:", e);
        return [];
    }
}
/** 실제 사용할 벡터 DB 선택 — DYN 전용 (fallback 없음) */
function getSigDB() {
    return Array.isArray(DYN_CVE_DB) ? DYN_CVE_DB : [];
}
/** 룰/벡터 DB에서 토큰화 규칙 수집 (JSON만 사용) */
function collectTokenizerPatterns() {
    const globalRules = [];
    const rootRules = RULE_DB?.tokenizer_rules;
    if (Array.isArray(rootRules))
        globalRules.push(...rootRules);
    for (const sig of RULE_DB || []) {
        const arr = sig.tokenizer_rules;
        if (Array.isArray(arr))
            globalRules.push(...arr);
    }
    const perSigRegex = [];
    for (const sig of DYN_CVE_DB || []) {
        const arr = sig.token_regex;
        if (Array.isArray(arr))
            perSigRegex.push(...arr);
    }
    return { globalRules, perSigRegex };
}
/** 코드 문자열 → 토큰 벡터(가중치 포함) — 100% JSON 데이터 구동 */
function vectorizeCodeToTokens(code) {
    const lower = code.toLowerCase();
    const feats = {};
    const add = (k, w = 1) => { feats[k] = (feats[k] ?? 0) + w; };
    // (1) 벡터 DB의 명시적 tokens 테이블: "정확 문자열" 존재 매칭
    const sigDB = getSigDB();
    if (sigDB.length) {
        for (const sig of sigDB) {
            const tokTable = sig.tokens || {};
            for (const [tok, wRaw] of Object.entries(tokTable)) {
                const w = typeof wRaw === "number" ? wRaw : 1;
                if (!tok)
                    continue;
                const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const wordLike = /^[A-Za-z0-9_]+$/.test(tok);
                const re = wordLike ? new RegExp(`\\b${esc}\\b`, "i") : new RegExp(esc, "i");
                if (re.test(lower))
                    add(tok, w);
            }
        }
    }
    // (2) 룰/벡터 DB가 제공하는 정규식 기반 토큰화 규칙
    const { globalRules, perSigRegex } = collectTokenizerPatterns();
    for (const r of [...globalRules, ...perSigRegex]) {
        if (!r?.rx)
            continue;
        try {
            const re = new RegExp(r.rx, "i");
            if (re.test(lower))
                add(r.name || r.rx, r.w ?? 1);
        }
        catch { /* 잘못된 정규식은 무시 */ }
    }
    return feats;
}
/** 코사인 유사도 (공통키 합집합 기반) */
function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const va = a[k] ?? 0;
        const vb = b[k] ?? 0;
        dot += va * vb;
        na += va * va;
        nb += vb * vb;
    }
    if (!na || !nb)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/** 코드 벡터 vs 시그니처 DB 유사도 계산 → severity 0..1, 상위 매치 리턴 */
function vectorCveScan(code) {
    const DB = getSigDB();
    if (!DB.length)
        return { aggregatedSeverity01: 0, matches: [] };
    const codeVec = vectorizeCodeToTokens(code);
    const results = DB.map((sig) => {
        const sim = cosineSim(codeVec, sig.tokens || {});
        const base = clamp01(sig.baseSeverity ?? 0.7);
        const sev = clamp01(base * Math.min(1, Math.pow(Math.max(0, sim), 0.8) * 1.2));
        return { id: sig.id, title: sig.title, similarity: sim, severity01: sev, notes: sig.notes ?? "" };
    }).sort((a, b) => b.severity01 - a.severity01);
    const topK = results.slice(0, 3);
    let agg = 0;
    for (const r of topK)
        agg = 1 - (1 - agg) * (1 - r.severity01);
    return { aggregatedSeverity01: Math.min(1, agg), matches: results.filter((r) => r.similarity > 0.15).slice(0, 5) };
}
/** 정규식 룰 DB 기반 CVE 휴리스틱 점수 (JSON만 사용) */
function regexHeuristicScoreFromDB(code, db) {
    if (!db?.length)
        return { severity01: 0, matches: [] };
    const lower = code.toLowerCase();
    const lines = lower.split(/\r?\n/);
    const RX = (rx) => new RegExp(rx, "i");
    const results = db.map((sig) => {
        let raw = 0;
        const matched = [];
        // 1) 룰 매칭: w * idf (idf 없으면 1)
        for (const r of sig.rules || []) {
            try {
                const re = RX(r.rx);
                if (re.test(lower)) {
                    const w = (r.w ?? 1) * (r.idf ?? 1);
                    raw += w;
                    matched.push(r.token || r.rx);
                }
            }
            catch { /* ignore bad rx */ }
        }
        // 2) 동시출현/근접/네거티브
        sig.cooccur?.forEach((c) => {
            const ok = (c.all || []).every((rx) => { try {
                return RX(rx).test(lower);
            }
            catch {
                return false;
            } });
            if (ok)
                raw += c.bonus || 0;
        });
        sig.proximity?.forEach((p) => {
            try {
                const A = RX(p.a), B = RX(p.b);
                const L = p.lines ?? 5;
                for (let i = 0; i < lines.length; i++) {
                    if (!A.test(lines[i]))
                        continue;
                    for (let d = -L; d <= L; d++) {
                        const j = i + d;
                        if (j >= 0 && j < lines.length && B.test(lines[j])) {
                            raw += p.bonus || 0;
                            d = L + 1;
                            break;
                        }
                    }
                }
            }
            catch { /* ignore */ }
        });
        sig.negatives?.forEach((n) => { try {
            if (RX(n.rx).test(lower))
                raw -= n.penalty || 0;
        }
        catch { } });
        // 3) BaseSeverity 결합 (룰 JSON의 값만 사용, support_docs 미세 보정)
        const base = clamp01(sig.baseSeverity ?? 0.7);
        const supBoost = Math.min(0.10, (Math.max(0, sig.support_docs ?? 0) / 1000)); // 0~+10%
        const sev = clamp01((base * (1 + supBoost)) * (1 - Math.exp(-3 * Math.max(0, raw))));
        return { id: sig.id, title: sig.title, severity01: sev, matched, raw: Number(Math.max(0, raw).toFixed(3)) };
    }).sort((a, b) => b.severity01 - a.severity01);
    const topK = results.slice(0, 3);
    let agg = 0;
    for (const r of topK)
        agg = 1 - (1 - agg) * (1 - r.severity01);
    return {
        severity01: clamp01(agg),
        matches: results.filter((r) => r.severity01 > 0.15).slice(0, 5)
    };
}
function isProbableEntrypoint(name, isExported, fileText) {
    if (isExported)
        return true; // 외부 공개는 우선 엔트리
    // 라우팅/핸들러 패턴(역할 기반 힌트)
    if (/\b(app|router)\.(get|post|put|delete|patch)\s*\(/.test(fileText))
        return true;
    if (/\bexport\s+default\b/.test(fileText) && /handler|route|loader/i.test(name))
        return true;
    return false;
}
function buildCallGraphFromTS(code, virtFileName = "snippet.ts") {
    const src = ts.createSourceFile(virtFileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const cg = {
        nodes: new Set(),
        edges: new Map(),
        indeg: new Map(),
        outdeg: new Map(),
        entrypoints: new Set(),
        changed: new Set(),
    };
    const fileText = code;
    const decls = [];
    const idOf = (name) => `${virtFileName}::${name}`;
    const addNode = (id) => {
        cg.nodes.add(id);
        if (!cg.edges.has(id))
            cg.edges.set(id, new Set());
        if (!cg.indeg.has(id))
            cg.indeg.set(id, 0);
        if (!cg.outdeg.has(id))
            cg.outdeg.set(id, 0);
    };
    const addEdge = (from, to) => {
        addNode(from);
        addNode(to);
        const s = cg.edges.get(from);
        if (!s.has(to)) {
            s.add(to);
            cg.outdeg.set(from, (cg.outdeg.get(from) || 0) + 1);
            cg.indeg.set(to, (cg.indeg.get(to) || 0) + 1);
        }
    };
    // 선언 수집
    const visitDecl = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.getText(src);
            const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            decls.push({ id: idOf(name), name, isExported, node });
        }
        else if (ts.isVariableStatement(node)) {
            const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            node.declarationList.declarations.forEach(d => {
                const name = d.name.getText(src);
                if (d.initializer && (ts.isFunctionExpression(d.initializer) || ts.isArrowFunction(d.initializer))) {
                    decls.push({ id: idOf(name), name, isExported, node: d.initializer });
                }
            });
        }
        else if (ts.isClassDeclaration(node) && node.name) {
            const name = node.name.getText(src);
            const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            decls.push({ id: idOf(name), name, isExported, node });
        }
        ts.forEachChild(node, visitDecl);
    };
    visitDecl(src);
    // 엔트리포인트 판정
    decls.forEach(d => {
        addNode(d.id);
        if (isProbableEntrypoint(d.name, d.isExported, fileText))
            cg.entrypoints.add(d.id);
    });
    // 호출 간선 수집
    const nameToId = new Map();
    decls.forEach(d => nameToId.set(d.name, d.id));
    const collectCallsIn = (node, current) => {
        if (ts.isCallExpression(node)) {
            let calleeName = "";
            if (ts.isIdentifier(node.expression)) {
                calleeName = node.expression.text;
            }
            else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
                calleeName = node.expression.name.text;
            }
            if (calleeName && current && nameToId.has(calleeName)) {
                addEdge(current, nameToId.get(calleeName));
            }
        }
        ts.forEachChild(node, n => collectCallsIn(n, current));
    };
    decls.forEach(d => collectCallsIn(d.node, d.id));
    // 이번 스니펫 내 선언 = 변경 세트
    decls.forEach(d => cg.changed.add(d.id));
    return cg;
}
function forwardReachable(cg, fromSet) {
    const seen = new Set();
    const stack = [...fromSet];
    while (stack.length) {
        const u = stack.pop();
        if (seen.has(u))
            continue;
        seen.add(u);
        const outs = cg.edges.get(u) || new Set();
        outs.forEach(v => { if (!seen.has(v))
            stack.push(v); });
    }
    return seen;
}
function anyPathToEntrypoint(cg, fromSet, entry) {
    const reach = forwardReachable(cg, fromSet);
    return reach.has(entry);
}
function centralityApprox(cg, nodes) {
    // 근사: (inDeg + outDeg) 평균을 전역 평균 대비 정규화
    let acc = 0;
    nodes.forEach(n => { acc += (cg.indeg.get(n) || 0) + (cg.outdeg.get(n) || 0); });
    const localAvg = nodes.size ? acc / nodes.size : 0;
    let total = 0;
    cg.nodes.forEach(n => { total += (cg.indeg.get(n) || 0) + (cg.outdeg.get(n) || 0); });
    const globalAvg = cg.nodes.size ? total / cg.nodes.size : 1;
    const raw = globalAvg ? (localAvg / (globalAvg * 2)) : 0; // 보수적 스케일
    return clamp01(raw);
}
function computeFSignalsSemantic(code, language) {
    const lang = (language || "").toLowerCase();
    if (!(lang.includes("ts") || lang.includes("js") || lang === "plaintext"))
        return null;
    let cg;
    try {
        cg = buildCallGraphFromTS(code);
    }
    catch {
        return null;
    }
    if (cg.nodes.size === 0)
        return { score: 0, details: { reason: "no nodes" } };
    const reach = forwardReachable(cg, cg.changed);
    const reachableNodesRatio = Math.min(1, reach.size / Math.max(1, cg.nodes.size));
    let impactedEntrypoints = 0;
    cg.entrypoints.forEach(ep => { if (anyPathToEntrypoint(cg, cg.changed, ep))
        impactedEntrypoints++; });
    const totalEntrypoints = Math.max(1, cg.entrypoints.size || 1);
    const impactedEntrypointRatio = Math.min(1, impactedEntrypoints / totalEntrypoints);
    const centralityScore = centralityApprox(cg, cg.changed);
    const w1 = 0.5, w2 = 0.3, w3 = 0.2;
    const score = clamp01(w1 * impactedEntrypointRatio + w2 * reachableNodesRatio + w3 * centralityScore);
    return {
        score,
        details: {
            impactedEntrypointRatio: Number(impactedEntrypointRatio.toFixed(3)),
            reachableNodesRatio: Number(reachableNodesRatio.toFixed(3)),
            centralityScore: Number(centralityScore.toFixed(3)),
            nodes: cg.nodes.size,
            entrypoints: cg.entrypoints.size
        }
    };
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function mapBigOTo01(bigO) {
    const lut = {
        "O(1)": 0.05,
        "O(log n)": 0.15,
        "O(n)": 0.20,
        "O(n log n)": 0.35,
        "O(n^2)": 0.70,
        "O(n^3)": 0.90,
        "unknown": 0.50
    };
    return lut[bigO] ?? 0.50;
}
const sat01 = (x, k) => clamp01(1 - Math.exp(-k * Math.max(0, x))); // 포화형 스케일러
function preciseResourceAndSecurityScan(code) {
    const reasons = [];
    const lower = code.toLowerCase();
    // Cyclomatic Complexity (간이)
    const branches = (code.match(/\b(if|else if|case|catch|&&|\|\||\?[:]|for|while|switch|try)\b/g) || []).length;
    const cc = 1 + branches;
    // 루프 및 중첩 근사
    const loopCount = (code.match(/\b(for|while|forEach|map\(|reduce\()/g) || []).length;
    const nestedLoop = /\b(for|while)\s*\([^)]*\)\s*{[^{}]*\b(for|while)\s*\(/s.test(code);
    const tripleNested = /\b(for|while)[\s\S]{0,300}\b(for|while)[\s\S]{0,300}\b(for|while)/s.test(code);
    const loopDepthApprox = tripleNested ? 3 : nestedLoop ? 2 : loopCount > 0 ? 1 : 0;
    // 정렬/분할정복/재귀 힌트
    const sortHint = /\b(sort\(|Collections\.sort|Arrays\.sort)\b/.test(code);
    const recursion = /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*{[\s\S]*?\b\1\s*\(/.test(code) ||
        /([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*=>[\s\S]*?\b\1\s*\(/.test(code);
    const divideAndConquerHint = recursion && /\b(mid|merge|partition|divide|conquer)\b/i.test(code);
    // 정규표현식 폭발 가능성
    const regexDosHint = /(a+)+|(\.\*){2,}|(.*){2,}/.test(code) && /(re\.compile|new\s+RegExp)/.test(code);
    // 외부 호출/IO
    const externalCalls = (code.match(/\b(fetch|axios|request|http\.|https\.|jdbc|mongo|redis|sequelize|prisma)\b/gi) || [])
        .length;
    const ioCalls = (code.match(/\bfs\.(read|write|append|unlink|readdir|chmod|chown)|open\(|readFileSync|writeFileSync\b/gi) || [])
        .length;
    // 메모리 바이트 근사
    let memBytesApprox = 0;
    const inc = (n) => { memBytesApprox += Math.max(0, n); };
    const bufAlloc = [...code.matchAll(/Buffer\.alloc\s*\(\s*(\d+)\s*\)/gi)];
    bufAlloc.forEach((m) => inc(parseInt(m[1], 10)));
    const arrAlloc = [...code.matchAll(/\bnew\s+Array\s*\(\s*(\d+)\s*\)|\bArray\s*\(\s*(\d+)\s*\)\.fill/gi)];
    arrAlloc.forEach((m) => inc((parseInt(m[1] || m[2], 10) || 0) * 8));
    const strLits = [...code.matchAll(/(["'`])([^"'`\\]|\\.){1,200}\1/g)];
    strLits.forEach((m) => inc(m[0]?.length || 0));
    const arrayLits = [...code.matchAll(/\[([^\[\]]{0,400})\]/g)];
    arrayLits.forEach((m) => {
        const elems = m[1].split(",").length || 0;
        inc(elems * 16);
    });
    const objectLits = [...code.matchAll(/\{([^{}]{0,400})\}/g)];
    objectLits.forEach((m) => {
        const props = (m[1].match(/:/g) || []).length;
        inc(props * 24);
    });
    const mapSet = (code.match(/\bnew\s+(Map|Set)\s*\(/g) || []).length;
    inc(mapSet * 128);
    // 권한/민감도
    let permRisk = 0;
    if (/\b(child_process|exec\(|spawn\(|system\(|popen\(|subprocess\.)/i.test(code))
        permRisk += 0.4;
    if (/\bfs\.(read|write|unlink|chmod|chown|readdir)\b/i.test(code))
        permRisk += 0.3;
    if (/\bprocess\.env\b|secret|password|credential/i.test(lower))
        permRisk += 0.3;
    permRisk = clamp01(permRisk);
    // 라이브러리 평판 (예시)
    let libRep = 0.65;
    if (/vulnerable[_-]?pkg[_-]?2023/.test(lower))
        libRep = Math.min(libRep, 0.1);
    // Big-O 추정
    let bigO = "unknown";
    if (loopDepthApprox >= 3)
        bigO = "O(n^3)";
    else if (loopDepthApprox === 2)
        bigO = "O(n^2)";
    else if (sortHint || divideAndConquerHint)
        bigO = "O(n log n)";
    else if (loopDepthApprox === 1 || recursion)
        bigO = "O(n)";
    else
        bigO = "unknown";
    // CVE: 정규식 룰(DB) + 벡터(DB) 결합 (둘 다 JSON 근거만 사용)
    const regexRules = regexHeuristicScoreFromDB(code, RULE_DB);
    const vectorRules = vectorCveScan(code);
    const cveSeverity01 = clamp01(1 - (1 - regexRules.severity01) * (1 - vectorRules.aggregatedSeverity01));
    // 이유
    if (regexRules.matches.length) {
        reasons.push(...regexRules.matches.map((m) => `regex:${m.id} sev=${m.severity01.toFixed(2)}`));
    }
    if (vectorRules.matches.length) {
        reasons.push(...vectorRules.matches.map((m) => `vector:${m.id} sim=${m.similarity.toFixed(2)} sev=${m.severity01.toFixed(2)}`));
    }
    if (regexDosHint)
        reasons.push("ReDoS pattern suspected");
    if (divideAndConquerHint)
        reasons.push("Divide-and-conquer recursion hint");
    if (sortHint)
        reasons.push("Sort usage hint");
    return {
        bigO,
        cc,
        loopCount,
        loopDepthApprox,
        recursion,
        divideAndConquerHint,
        sortHint,
        regexDosHint,
        memAllocs: bufAlloc.length + arrAlloc.length + arrayLits.length + objectLits.length + mapSet,
        memBytesApprox,
        externalCalls,
        ioCalls,
        cveSeverity01,
        libReputation01: libRep,
        licenseMismatch: false,
        permRisk01: permRisk,
        _reasons: reasons
    };
}
/* ---------- 정적 파이프라인 실행 ---------- */
async function runStaticPipeline(code, filename, _language) {
    const lineCount = (code.match(/\n/g) || []).length + 1;
    // 기능성(F) 근사 — 기존(키워드 기반) 입력값
    const totalApis = Math.max(1, (code.match(/\bexport\s+(function|class|interface|type|const|let|var)\b/g) || []).length || 5);
    const coreTouched = !!filename && /(\/|^)(core|service|domain)\//i.test(filename);
    const diffChangedLines = Math.min(200, Math.round(lineCount * 0.2));
    const schemaChanged = /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|MIGRATION)\b/i.test(code);
    // 정밀 리소스/보안
    const pr = preciseResourceAndSecurityScan(code);
    const metrics = {
        // SF (기초)
        apiChanges: 0,
        totalApis,
        coreTouched,
        diffChangedLines,
        totalLines: Math.max(1, lineCount),
        schemaChanged,
        // SR
        bigO: pr.bigO,
        cc: pr.cc,
        loopCount: pr.loopCount,
        loopDepthApprox: pr.loopDepthApprox,
        recursion: pr.recursion,
        divideAndConquerHint: pr.divideAndConquerHint,
        sortHint: pr.sortHint,
        regexDosHint: pr.regexDosHint,
        memAllocs: pr.memAllocs,
        memBytesApprox: pr.memBytesApprox,
        externalCalls: pr.externalCalls,
        ioCalls: pr.ioCalls,
        // SD
        cveSeverity01: pr.cveSeverity01,
        libReputation01: pr.libReputation01,
        licenseMismatch: pr.licenseMismatch,
        permRisk01: pr.permRisk01,
        _reasons: pr._reasons
    };
    // 의미 기반 SF(호출그래프) 시도 — TS/JS에서만 계산, 실패 시 그냥 생략
    try {
        const sem = computeFSignalsSemantic(code, _language);
        if (sem) {
            metrics.semanticF = {
                score: sem.score,
                impactedEntrypointRatio: sem.details.impactedEntrypointRatio ?? 0,
                reachableNodesRatio: sem.details.reachableNodesRatio ?? 0,
                centralityScore: sem.details.centralityScore ?? 0
            };
        }
    }
    catch { /* ignore semantic errors */ }
    return metrics;
}
/* ---------- 가중치 ---------- */
const WF = { api: 0.40, core: 0.25, diff: 0.20, schema: 0.15 };
const WR = { bigO: 0.32, cc: 0.18, mem: 0.22, ext: 0.18, io: 0.10 };
const WD = { cve: 0.42, rep: 0.25, lic: 0.10, perm: 0.23 };
/* ---- 차원 점수 계산 ---- */
function computeFSignalsFromMetrics(m) {
    // 의미 기반 점수가 있으면 우선 사용 (키워드 매칭 탈피)
    if (m.semanticF) {
        const semanticOnly = m.semanticF.score; // 0..1
        return clamp01(semanticOnly);
    }
    // 폴백: 기존 키워드 기반
    const apiRatio = clamp01(m.apiChanges / Math.max(1, m.totalApis));
    const diffRatio = clamp01(m.diffChangedLines / Math.max(1, m.totalLines));
    const v = apiRatio * WF.api + (m.coreTouched ? 1 : 0) * WF.core + diffRatio * WF.diff + (m.schemaChanged ? 1 : 0) * WF.schema;
    return clamp01(v);
}
function computeRSignalsFromMetrics(m) {
    const bigO = mapBigOTo01(m.bigO);
    const ccNorm = clamp01(1 - Math.exp(-0.12 * Math.max(0, m.cc - 1)));
    const memByteNorm = clamp01(Math.log2(Math.max(1, m.memBytesApprox)) / 24);
    const memAllocNorm = clamp01(1 - Math.exp(-0.06 * m.memAllocs));
    const mem = clamp01(0.7 * memByteNorm + 0.3 * memAllocNorm);
    const ext = clamp01(1 - Math.exp(-0.05 * m.externalCalls));
    const io = clamp01(1 - Math.exp(-0.06 * m.ioCalls));
    const v = bigO * WR.bigO + ccNorm * WR.cc + mem * WR.mem + ext * WR.ext + io * WR.io;
    return clamp01(v);
}
function computeDSignalsFromMetrics(m) {
    const v = m.cveSeverity01 * WD.cve + (1 - m.libReputation01) * WD.rep + (m.licenseMismatch ? 1 : 0) * WD.lic + m.permRisk01 * WD.perm;
    return clamp01(v);
}
/* ---------- Static metrics → FRD 벡터 ---------- */
function analyzeFromStaticMetrics(metrics, filename) {
    const F = computeFSignalsFromMetrics(metrics);
    const R = computeRSignalsFromMetrics(metrics);
    const D = computeDSignalsFromMetrics(metrics);
    const vector = [F, R, D];
    const signalTable = {
        F: {
            apiRatio: clamp01(metrics.apiChanges / Math.max(1, metrics.totalApis)),
            coreModuleModified: metrics.coreTouched ? 1 : 0,
            diffLineRatio: clamp01(metrics.diffChangedLines / Math.max(1, metrics.totalLines)),
            schemaChanged: metrics.schemaChanged ? 1 : 0,
            // 의미 기반 지표 노출
            semanticScore: metrics.semanticF?.score ?? 0,
            influencedEntrypoints: metrics.semanticF?.impactedEntrypointRatio ?? 0,
            reachability: metrics.semanticF?.reachableNodesRatio ?? 0,
            centrality: metrics.semanticF?.centralityScore ?? 0
        },
        R: {
            timeComplexity: mapBigOTo01(metrics.bigO),
            cyclomaticComplexity: metrics.cc,
            loopDepthApprox: metrics.loopDepthApprox,
            memBytesApprox: metrics.memBytesApprox,
            memNorm: clamp01(0.7 * (Math.log2(Math.max(1, metrics.memBytesApprox)) / 24) + 0.3 * (1 - Math.exp(-0.06 * metrics.memAllocs))),
            externalCallNorm: clamp01(1 - Math.exp(-0.05 * metrics.externalCalls)),
            ioCallNorm: clamp01(1 - Math.exp(-0.06 * metrics.ioCalls))
        },
        D: {
            cveSeverity: metrics.cveSeverity01,
            libReputation: metrics.libReputation01,
            licenseMismatch: metrics.licenseMismatch ? 1 : 0,
            sensitivePerm: metrics.permRisk01
        }
    };
    return { vector, filename, signalTable, reasons: metrics._reasons };
}
/* ---------- CRAI 식(2) ---------- */
function scoreFromVector(v, top) {
    const cfg = top ?? { wF: 0.40, wR: 0.30, wD: 0.30 };
    const SF = clamp01(v[0]);
    const SR = clamp01(v[1]);
    const SD = clamp01(v[2]);
    const B = 10 * (cfg.wF * SF + cfg.wR * SR + cfg.wD * SD);
    const wrSum = cfg.wF + cfg.wR;
    const mixFR = wrSum > 0 ? (cfg.wF / wrSum) * SF + (cfg.wR / wrSum) * SR : 0;
    const C = Math.min(10, 10 * (SD + (1 - SD) * mixFR));
    const rho = SD / (SF + SR + SD + 1e-6);
    const s = smoothstep(SD, 0.4, 0.7);
    const alpha = s * (0.5 + 0.5 * rho);
    const craiRaw = (1 - alpha) * B + alpha * C;
    const score = Math.min(10, craiRaw);
    let severity = "green";
    let level = "LOW";
    let action = "Quick scan sufficient";
    if (score >= 9.0) {
        severity = "red";
        level = "CRITICAL";
        action = "Comprehensive audit needed";
    }
    else if (score >= 7.0) {
        severity = "orange";
        level = "HIGH";
        action = "Detailed review required";
    }
    else if (score >= 4.0) {
        severity = "yellow";
        level = "MEDIUM";
        action = "Standard review process";
    }
    return {
        score,
        severity,
        level,
        action,
        weights: cfg,
        crai_components: { B, C, alpha, rho, s, SF, SR, SD, mixFR }
    };
}
/* ----- smoothstep 스무딩 함수 ----- */
function smoothstep(x, a, b) {
    if (x <= a)
        return 0;
    if (x >= b)
        return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}
/* ---------- Filename hint ---------- */
function detectSuggestedFileName(fullText, _fallbackLang) {
    const re = /(?:file\s*[:=]\s*|create\s*|\bmake\s*|\bsave\s*as\s*|\b파일(?:명|을)?\s*(?:은|을)?\s*)([A-Za-z0-9_\-./]+?\.[A-Za-z]{1,8})/gi;
    let m;
    let last = null;
    while ((m = re.exec(fullText)) !== null)
        last = m[1];
    if (!last)
        return null;
    const extMatch = last.match(/\.([A-Za-z0-9]{1,8})$/);
    if (!extMatch)
        return null;
    const ext = extMatch[1];
    if (!/[A-Za-z]/.test(ext))
        return null;
    if (/^\d+(\.\d+)+$/.test(last))
        return null;
    if (last.includes(".."))
        return null;
    return last.replace(/^\/+/, "");
}
/** 마지막 코드블록 추출 (```lang\ncode```) — (레거시 호환용) */
function extractLastCodeBlockTS(text) {
    const regex = /```([\s\S]*?)```/g;
    let match;
    let last = null;
    while ((match = regex.exec(text)) !== null)
        last = match[1];
    if (!last)
        return null;
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
/** 전체 코드블록 배열 추출 (```lang\ncode```) */
function extractCodeBlocksTS(text) {
    const blocks = [];
    const regex = /```([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const body = match[1] ?? "";
        const nl = body.indexOf("\n");
        if (nl > -1) {
            const maybeLang = body.slice(0, nl).trim();
            const code = body.slice(nl + 1);
            const language = /^[a-zA-Z0-9+#._-]{0,20}$/.test(maybeLang) && maybeLang ? maybeLang : "plaintext";
            blocks.push({ language, code, suggested: detectSuggestedFileName(code, language) });
        }
        else {
            blocks.push({ language: "plaintext", code: body, suggested: null });
        }
    }
    return blocks;
}
/* ======================================================================
 *  승인 후 코드 적용 (단일/여러 스니펫)
 * ==================================================================== */
async function handleApproval(code, language, suggested) {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
        return;
    }
    const shellCmdPattern = /^(npm|yarn|pip|pip3|pnpm|apt|apt-get|brew|git|chmod|chown|sudo|rm|mv|cp|mkdir|rmdir|systemctl|service|curl|bash)\b/i;
    const firstLine = (code || "").trim().split(/\r?\n/)[0] || "";
    const looksLikeShell = language === "bash" || language === "sh" || shellCmdPattern.test(firstLine);
    const denylist = [
        /\brm\s+-rf?\s+\/?[^]*?/i,
        /\bsudo\b/i,
        /\bchown\b/i,
        /\bmkfs\w*\b/i,
        /\bdd\s+if=\/dev\/zero\b/i,
        /\bshutdown\b|\breboot\b/i,
        /\bcurl\b.*\|\s*sh\b/i
    ];
    if (looksLikeShell) {
        if (denylist.some((rx) => rx.test(code))) {
            vscode.window.showErrorMessage("위험 명령이 감지되어 실행을 차단했습니다.");
            return;
        }
        const confirm = await vscode.window.showWarningMessage("터미널 명령으로 감지되었습니다. 통합 터미널에서 실행할까요?", { modal: true }, "실행", "취소");
        if (confirm !== "실행")
            return;
        const termName = "AI Approval Agent";
        let terminal = vscode.window.terminals.find((t) => t.name === termName);
        if (!terminal)
            terminal = vscode.window.createTerminal({ name: termName });
        terminal.show(true);
        const lines = code.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        for (const line of lines)
            terminal.sendText(line, true);
        vscode.window.showInformationMessage(`터미널에서 ${lines.length}개 명령을 실행했습니다.`);
        return;
    }
    const choice = await vscode.window.showQuickPick([
        { label: "Overwrite current file", description: "활성 에디터의 전체 내용을 교체" },
        { label: "Insert at cursor", description: "활성 에디터의 현재 커서 위치에 삽입" },
        { label: "Save as new file", description: "새 파일로 저장 (현재 동작)" }
    ], { placeHolder: "승인된 코드를 어디에 적용할까요?" });
    if (!choice)
        return;
    if (choice.label === "Overwrite current file") {
        const uri = await overwriteActiveEditor(code);
        if (uri)
            vscode.window.showInformationMessage(`현재 파일에 덮어썼습니다: ${uri.fsPath}`);
        return;
    }
    if (choice.label === "Insert at cursor") {
        const uri = await insertAtCursor(code);
        if (uri)
            vscode.window.showInformationMessage(`현재 파일 커서 위치에 삽입했습니다: ${uri.fsPath} (저장은 Ctrl/Cmd+S)`);
        return;
    }
    const root = vscode.workspace.workspaceFolders[0].uri;
    const ext = guessExtension(language);
    const targetRel = sanitizeRelativePath(suggested) || (await nextAutoName(root, ext));
    await ensureParentDir(root, targetRel);
    const fileUri = vscode.Uri.joinPath(root, targetRel);
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(fileUri, enc.encode(code));
    vscode.window.showInformationMessage(`승인됨 → ${targetRel} 저장 완료`);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc);
}
/** 여러 스니펫 일괄 승인 */
async function handleApprovalMany(snippets) {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage("워크스페이스가 열려 있지 않습니다.");
        return;
    }
    if (!snippets.length)
        return;
    const choice = await vscode.window.showQuickPick([
        { label: "Save each as new file", description: "각 블록을 개별 새 파일로 저장" },
        { label: "Insert concatenated", description: "활성 에디터 커서 위치에 모두 이어붙여 삽입" },
        { label: "Create folder & save", description: "하위 폴더를 만들고 파일별로 저장" }
    ], { placeHolder: "여러 코드블록을 어떻게 적용할까요?" });
    if (!choice)
        return;
    const root = vscode.workspace.workspaceFolders[0].uri;
    if (choice.label === "Insert concatenated") {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("활성 에디터가 없습니다.");
            return;
        }
        const joined = snippets.map((s) => s.code).join("\n\n");
        await editor.edit((eb) => eb.insert(editor.selection.active, joined));
        vscode.window.showInformationMessage(`총 ${snippets.length}개 블록을 현재 문서에 삽입했습니다.`);
        return;
    }
    if (choice.label === "Save each as new file") {
        for (const s of snippets) {
            const ext = guessExtension(s.language);
            const targetRel = sanitizeRelativePath(s.suggested) || (await nextAutoName(root, ext));
            await ensureParentDir(root, targetRel);
            const fileUri = vscode.Uri.joinPath(root, targetRel);
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(s.code));
        }
        vscode.window.showInformationMessage(`총 ${snippets.length}개 블록을 개별 파일로 저장했습니다.`);
        return;
    }
    if (choice.label === "Create folder & save") {
        const folderName = `generated_${Date.now()}`;
        const folderUri = vscode.Uri.joinPath(root, folderName);
        await vscode.workspace.fs.createDirectory(folderUri);
        for (let i = 0; i < snippets.length; i++) {
            const s = snippets[i];
            const ext = guessExtension(s.language);
            const base = s.suggested && sanitizeRelativePath(s.suggested)
                ? sanitizeRelativePath(s.suggested)
                : `snippet_${String(i + 1).padStart(2, "0")}.${ext}`;
            const rel = base.includes("/") ? base.split("/").pop() : base;
            const fileUri = vscode.Uri.joinPath(folderUri, rel);
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(s.code));
        }
        vscode.window.showInformationMessage(`폴더 ${folderName} 아래에 ${snippets.length}개 파일을 저장했습니다.`);
        return;
    }
}
/* --- 활성 에디터 전체 덮어쓰기 --- */
async function overwriteActiveEditor(code) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("활성 텍스트 에디터가 없습니다.");
        return null;
    }
    const doc = editor.document;
    if (doc.isClosed) {
        vscode.window.showErrorMessage("활성 문서를 열 수 없습니다.");
        return null;
    }
    const lastLine = doc.lineAt(Math.max(0, doc.lineCount - 1));
    const fullRange = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
    await editor.edit((eb) => eb.replace(fullRange, code));
    await doc.save();
    return doc.uri;
}
/* --- 커서 위치 삽입 --- */
async function insertAtCursor(code) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("활성 에디터가 없습니다.");
        return null;
    }
    const doc = editor.document;
    if (doc.isClosed) {
        vscode.window.showErrorMessage("활성 문서를 열 수 없습니다.");
        return null;
    }
    const pos = editor.selection.active;
    await editor.edit((eb) => eb.insert(pos, code));
    return doc.uri;
}
/* ---------- Fs utils ---------- */
function guessExtension(language) {
    const map = {
        javascript: "js",
        typescript: "ts",
        python: "py",
        html: "html",
        css: "css",
        java: "java",
        c: "c",
        cpp: "cpp",
        tsx: "tsx",
        jsx: "jsx",
        json: "json",
        plaintext: "txt",
        bash: "sh",
        sh: "sh",
        kotlin: "kt"
    };
    const key = (language || "").toLowerCase().trim();
    return map[key] || (key.match(/^[a-z0-9]+$/) ? key : "txt");
}
function sanitizeRelativePath(p) {
    if (!p)
        return null;
    if (p.includes(".."))
        return null;
    return p.replace(/^\/+/, "").trim();
}
async function nextAutoName(root, ext) {
    const base = "generated_code";
    for (let i = 1; i <= 9999; i++) {
        const name = `${base}_${String(i).padStart(3, "0")}.${ext}`;
        const uri = vscode.Uri.joinPath(root, name);
        try {
            await vscode.workspace.fs.stat(uri);
        }
        catch {
            return name;
        }
    }
    return `${base}_${Date.now()}.${ext}`;
}
async function ensureParentDir(root, relPath) {
    const parts = relPath.split("/").slice(0, -1);
    if (!parts.length)
        return;
    let cur = root;
    for (const part of parts) {
        cur = vscode.Uri.joinPath(cur, part);
        try {
            await vscode.workspace.fs.stat(cur);
        }
        catch {
            await vscode.workspace.fs.createDirectory(cur);
        }
    }
}
/* ---------- HTML / Nonce ---------- */
function getHtml(webview, ctx, nonce) {
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
  <style>
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ddd);
      font-family: var(--vscode-font-family, "Segoe UI", Roboto, "Helvetica Neue", Arial);
    }

    .chat {
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
      padding: 10px;
    }

    .chat-header {
      font-weight: 700;
      font-size: 16px;
      margin-bottom: 10px;
    }

    .chat-body {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      background: var(--vscode-sideBar-background, #252526);
      border-radius: 6px;
      box-shadow: inset 0 0 3px rgba(0,0,0,0.4);
      margin-bottom: 10px;
    }

    #composer {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
    }

    #composer #prompt {
      flex: 1 1 auto;
      width: 100%;
      min-width: 0;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ddd);
      font-size: 13px;
      box-sizing: border-box;
    }

    #composer button {
      flex: 0 0 auto;
      padding: 8px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      font-weight: 600;
      font-size: 13px;
      transition: background 0.15s ease-in-out;
    }

    #composer button:hover {
      background: var(--vscode-button-hoverBackground, #0b7dd8);
    }
  </style>
  <title>AI Approval Agent</title>
</head>
<body>
  <section class="chat">
    <div class="chat-header">AI Approval Agent</div>
    <div class="chat-body" id="chat">
      <div class="msg bot">
        How can I help? If you request "code generation," you can choose to approve or reject the generated code.
      </div>
    </div>
    <form id="composer">
      <input id="prompt" type="text" placeholder="Ex) Generate starter code for an Express server." />
      <button type="submit">Send</button>
    </form>
  </section>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
function deactivate() { }
//# sourceMappingURL=extension.js.map