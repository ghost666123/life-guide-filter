#!/usr/bin/env node
/* 线上验收：把线上 index.html 里【内联的】search.js 和语料抽出来，
   用本地的验收用例跑一遍。验的是真正发出去的那份代码，不是本地副本。
   用法：node verify-live.js  （先 curl 下载到 /tmp/live.html，或用参数指定路径） */
"use strict";
const fs = require("fs");
const path = require("path");
const HERE = __dirname;

const livePath = process.argv[2] || "/tmp/live.html";
const html = fs.readFileSync(livePath, "utf8");

// ── 抽 search.js ────────────────────────────────────────────────
// 用标记定位而不是整段字符串比对：线上是 LF、本地构建产物是 CRLF，
// 硬比字符串会在一边失败。
const END = '})(typeof window !== "undefined" ? window : globalThis);';
const mi = html.indexOf("search.js —— 建议搜索内核");
const a = mi < 0 ? -1 : html.lastIndexOf("/*", mi);
const b = mi < 0 ? -1 : html.indexOf(END, mi);
if (a < 0 || b < 0) { console.error("✗ 页面里找不到内联的 search.js"); process.exit(1); }
const src = html.slice(a, b + END.length);
console.log("内联 search.js 长度: " + src.length + " 字节");

const g = {};
new Function("globalThis", "window", src + "\n;globalThis.__SC = (typeof window!=='undefined'?window:globalThis).SearchCore;")(g, g);
const SC = g.__SC;
if (!SC) { console.error("✗ 内联脚本执行后没有 SearchCore"); process.exit(1); }

// ── 抽语料 ─────────────────────────────────────────────────────
const m = html.match(/<script[^>]*id="corpus"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error("✗ 线上页面里找不到语料块"); process.exit(1); }
const corpus = JSON.parse(m[1]);
const E = corpus.entries;
console.log("线上语料条目数: " + E.length);

// ── 跟本地数据对账 ─────────────────────────────────────────────
const local = JSON.parse(fs.readFileSync(path.join(HERE, "data", "corpus.json"), "utf8"));
const same = JSON.stringify(local.entries) === JSON.stringify(E);
console.log("线上语料 == 本地 data/corpus.json : " + (same ? "✓" : "✗ 不一致"));

for (const e of E) {
  const cs = e.cs;
  e.ratio = e.level === "大" ? (cs === 0 ? "极高" : (cs <= 2 ? "高" : "一般"))
          : e.level === "中" ? (cs === 0 ? "高" : "一般") : "一般";
}

// ── 跑同一套用例 ───────────────────────────────────────────────
const spec = JSON.parse(fs.readFileSync(path.join(HERE, "search-test.json"), "utf8"));
const ixl = SC.buildIndex(local.entries.map(e => Object.assign({}, e)));
const ix = SC.buildIndex(E);
const nz = new Set(spec.must_not_be_zero || []);
const T = spec.thresholds;

let fail = 0;
function group(name, list, top1min, zeromax, avgmax) {
  let z = 0, ok = 0, j = 0, sum = 0;
  for (const c of list) {
    const n = SC.search(c.q, E, ix);
    if (n.length === 0 && (c.expect || nz.has(c.q))) z++;
    sum += n.length;
    if (c.expect) { j++; if (n.length && new RegExp(c.expect).test(n[0].entry.title + " " + (n[0].entry.human || ""))) ok++; }
  }
  const top1 = j ? ok / j : 1, avg = sum / list.length;
  const pass = z <= zeromax && top1 >= top1min && avg <= avgmax;
  if (!pass) fail++;
  console.log(`  ${pass ? "✓" : "✗"} ${name.padEnd(10)} 零结果 ${z}/${list.length}  首条 ${(top1 * 100).toFixed(0)}%  平均 ${avg.toFixed(0)} 条`);
  return { ok, j };
}
console.log("\n线上搜索验收：");
group("基础组", spec.cases, T.top1_min_ratio, T.zero_result_max, T.max_results_avg);
group("难例组", spec.hard, T.hard_top1_min_ratio, T.hard_zero_result_max, T.hard_max_results_avg);

// 安全类：要求【前三名里出现 12356 求助热线】。
// 只查标题不够 —— 「自杀念头一冒出来先告诉身边的一个人」这条正文里才有热线，
// 而它才是「想死」最该看到的答案。
console.log("\n线上安全兜底（前三名里必须有 12356）：");
for (const q of ["死", "想死", "活着没意思", "不想活了", "感觉熬不下去了"]) {
  const n = SC.search(q, E, ix);
  const top3 = n.slice(0, 3).map(r => r.entry.title + (r.entry.human || "") + (r.entry.note || ""));
  const hotline = top3.some(t => /12356/.test(t));
  const good = n.length > 0 && hotline;
  if (!good) fail++;
  console.log(`  ${good ? "✓" : "✗"} 「${q}」→ ${n.length} 条，前三含 12356: ${hotline}` +
              `\n      首条：${n.length ? n[0].entry.title.slice(0, 44) : "—— 零 ——"}`);
}

// 关键回归项：这几条是这轮修的，线上必须也是对的
console.log("\n关键回归项：");
const regress = [
  ["被裁了而且没钱交房租", /被裁|经济补偿/],
  ["我上个月被裁员了现在没有收入还要还房贷", /被裁|裁员|经济补偿|失业/],
  ["我跟房东签了合同但他现在不退我押金我该怎么办", /押金|房东|租金/],
  ["压金不退怎么办", /押金|租金|房东/],
  ["信用卡还不上了怎么办", /信用卡|逾期|债务|还不上/]
];
for (const [q, re] of regress) {
  const n = SC.search(q, E, ix);
  const good = n.length && re.test(n[0].entry.title + " " + (n[0].entry.human || ""));
  if (!good) fail++;
  console.log(`  ${good ? "✓" : "✗"} 「${q}」→ 首条：${n.length ? n[0].entry.title.slice(0, 40) : "—— 零 ——"}`);
}

console.log(fail ? `\n${fail} 项未通过。` : "\n线上验收全部通过。");
process.exit(fail ? 1 : 0);
