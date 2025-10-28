// scripts/build_cve_vocab.ts
import * as fs from "fs";
import * as path from "path";

type CveDoc = { id: string; text: string; cwes: string[] };

const CVE_DIR = path.join(__dirname, "..", "cve_data");
const OUT_PATH = path.join(CVE_DIR, "generated_cve_db.json");

// ------------------ 유틸: 토큰화 ------------------
function tokenize(text: string): string[] {
  if (!text) return [];
  // 간단하고 재현 가능한 토큰화: 식별자+단어(언더스코어, 닷 포함)
  return (text.toLowerCase().match(/[a-z_][a-z0-9_.]+/g) || [])
    .map(t => t.replace(/^_+|_+$/g, "")) // 앞뒤 언더스코어 정리
    .filter(Boolean);
}

// ------------------ 1) CVE 파일 읽기 ------------------
function loadCveDocsFromDir(dir: string): CveDoc[] {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const docs: CveDoc[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const obj = JSON.parse(raw);
      // 여러 형식에 대비: NVD/other variations
      const id = obj?.cveMetadata?.cveId || obj?.CVE_data_meta?.ID || f;
      // description: 여러 위치에서 찾음
      let desc = "";
      if (obj?.containers?.cna?.descriptions) {
        desc = obj.containers.cna.descriptions.map((d:any)=>d.value || "").join(" ");
      } else if (obj?.CVE_Items && Array.isArray(obj.CVE_Items)) {
        // NVD export style
        const it = obj.CVE_Items[0];
        desc = (it?.cve?.description?.description_data?.[0]?.value) || "";
      }
      const problemTypes: string[] = [];
      if (obj?.containers?.cna?.problemTypes) {
        for (const pt of obj.containers.cna.problemTypes) {
          if (pt.descriptions) for (const d of pt.descriptions) {
            if (d.cweId) problemTypes.push(d.cweId);
          }
        }
      }
      docs.push({ id, text: desc, cwes: problemTypes });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`skip file: ${f}: ${msg}`);
    }
  }
  return docs;
}

// ------------------ 2) TF 및 DF 계산 ------------------
function buildTfDf(docs: CveDoc[]) {
  const TFs: Record<string, Record<string, number>> = {};
  const DF: Record<string, number> = {};
  for (const d of docs) {
    const toks = tokenize(d.text);
    TFs[d.id] = TFs[d.id] || {};
    // 문서 내 TF
    for (const t of toks) TFs[d.id][t] = (TFs[d.id][t] || 0) + 1;
    // DF: 문서 단위로 한 번만 카운트
    const uniq = new Set(toks);
    for (const t of uniq) DF[t] = (DF[t] || 0) + 1;
  }
  return { TFs, DF };
}

// ------------------ 3) IDF 계산 ------------------
function computeIdf(DF: Record<string, number>, N: number) {
  const IDF: Record<string, number> = {};
  for (const k of Object.keys(DF)) {
    IDF[k] = Math.log(1 + N / (DF[k])); // smoothed IDF
  }
  return IDF;
}

// ------------------ 4) 특정 시그니처(라벨)용 token score 계산 ------------------
function buildSignature(label: string, docs: CveDoc[], TFs: any, IDF: any, docFilter: (d:CveDoc)=>boolean, topK=30) {
  const relevant = docs.filter(docFilter);
  const scoreMap: Record<string, number> = {};
  for (const d of relevant) {
    const tf = TFs[d.id] || {};
    for (const t of Object.keys(tf)) {
      scoreMap[t] = (scoreMap[t] || 0) + tf[t] * (IDF[t] || 0);
    }
  }
  const entries = Object.entries(scoreMap).sort((a,b)=>b[1]-a[1]).slice(0, topK);
  // 스케일링: raw scores -> [0.5, 1.8]
  const vals = entries.map(e=>e[1]);
  const maxv = Math.max(...vals, 1);
  const minv = Math.min(...vals, 0);
  const tokens: Record<string, number> = {};
  for (const [tok, raw] of entries) {
    const s = (raw - minv) / (maxv - minv + 1e-12);
    const w = 0.5 + 1.3 * s; // 0.5..1.8
    tokens[tok] = +w.toFixed(3);
  }
  // baseSeverity는 실험 초기값(나중에 수동 보정 가능)
  return { id: label, title: label, baseSeverity: 0.90, tokens };
}

// ------------------ 메인 ------------------
function main() {
  const docs = loadCveDocsFromDir(CVE_DIR);
  console.log("Loaded docs:", docs.length);
  const { TFs, DF } = buildTfDf(docs);
  const IDF = computeIdf(DF, docs.length);

  // 예시 1: Command Injection 시그니처 (간단 키워드 기반 docFilter)
  const sigCmd = buildSignature("SIG-CMD-INJECT", docs, TFs, IDF, (d) => {
    // 양성 문서 판단 기준: description 내에 실행 관련 키워드 또는 CWE-78 포함
    return (/exec|system|child_process|popen|spawn|bash|sh/.test(d.text) || (d.cwes || []).some(c=>/CWE-78/.test(String(c))));
  }, 40);

  // 더 만들고 싶으면 유사 방식으로 만든다 (SQLi, Deser 등)
  const generated = [sigCmd];

  fs.writeFileSync(OUT_PATH, JSON.stringify(generated, null, 2), "utf8");
  console.log("Wrote generated CVE DB to", OUT_PATH);
  // 토큰 샘플 출력
  console.log("Top tokens for SIG-CMD-INJECT:", Object.entries(sigCmd.tokens).slice(0,20));
}

main();
