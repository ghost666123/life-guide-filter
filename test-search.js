#!/usr/bin/env node
/* 搜索验收：node test-search.js
   直接 require search.js —— 和浏览器跑的是同一份代码，不存在两套实现漂移。
   退出码 0 = 全过，1 = 有指标不达标。 */
"use strict";
const fs = require("fs");
const path = require("path");
const HERE = __dirname;
require(path.join(HERE, "search.js"));
const SC = globalThis.SearchCore;

const corpus = JSON.parse(fs.readFileSync(path.join(HERE, "data", "corpus.json"), "utf8"));
const spec = JSON.parse(fs.readFileSync(path.join(HERE, "search-test.json"), "utf8"));
const E = corpus.entries;

// 派生字段（index.html 里也是这么做，测试要跟线上一致）
const RR = { "极高": 0, "高": 1, "一般": 2 }, GR = { A: 0, B: 1, C: 2 };
for (const e of E) {
  const cs = e.cs;
  e.ratio = e.level === "大" ? (cs === 0 ? "极高" : (cs <= 2 ? "高" : "一般"))
          : e.level === "中" ? (cs === 0 ? "高" : "一般") : "一般";
}
// 旧的整串匹配，用来做对照
function oldSearch(q) {
  const ts = q.toLowerCase().split(/\s+/).filter(Boolean);
  return E.filter(e => {
    const hay = [e.title, e.human, e.cost, e.gain, e.note, e.src, e.grade].join("\n").toLowerCase();
    return ts.every(t => hay.includes(t));
  });
}

const ix = SC.buildIndex(E);
const rows = [];
let oldZero = 0, newZero = 0, ok = 0, judged = 0, sumN = 0, criticalFail = [];

for (const c of spec.cases) {
  const o = oldSearch(c.q);
  const n = SC.search(c.q, E, ix);
  if (o.length === 0) oldZero++;
  if (n.length === 0) newZero++;
  sumN += n.length;
  let mark = "";
  if (c.expect) {
    judged++;
    const re = new RegExp(c.expect);
    const top = n.length ? (n[0].entry.title + " " + (n[0].entry.human || "")) : "";
    const good = re.test(top);
    if (good) ok++;
    mark = good ? "✓" : "✗";
    if (!good && c.critical) criticalFail.push(c.q);
  } else {
    mark = "·";   // 书里确实没有，不判对错
  }
  rows.push({ q: c.q, o: o.length, n: n.length, mark,
              top: n.length ? n[0].entry.title.slice(0, 46) : "—— 零 ——",
              score: n.length ? n[0].score.toFixed(2) : "" });
}

const T = spec.thresholds;
const avg = sumN / spec.cases.length;
const top1 = judged ? ok / judged : 1;

console.log("\n" + "输入".padEnd(22) + "旧".padStart(4) + "新".padStart(4) + "  判   新首条");
console.log("─".repeat(108));
for (const r of rows)
  console.log(r.q.padEnd(22) + String(r.o).padStart(4) + String(r.n).padStart(4) + "  " + r.mark + "   " + r.top);

const checks = [
  ["零结果 ≤ " + T.zero_result_max,      newZero <= T.zero_result_max, newZero],
  ["首条正确率 ≥ " + (T.top1_min_ratio * 100) + "%", top1 >= T.top1_min_ratio, (top1 * 100).toFixed(0) + "%"],
  ["平均返回条数 ≤ " + T.max_results_avg,  avg <= T.max_results_avg,     avg.toFixed(0)],
  ["安全类查询（活着没意思）命中",         criticalFail.length === 0,     criticalFail.join(",") || "ok"]
];
console.log("\n" + "─".repeat(108));
console.log(`对照：旧搜索零结果 ${oldZero}/${spec.cases.length}  →  新搜索 ${newZero}/${spec.cases.length}`);
let bad = 0;
for (const [name, passed, got] of checks) {
  console.log(`  ${passed ? "✓" : "✗"} ${name}   实际 ${got}`);
  if (!passed) bad++;
}
if (bad) { console.log(`\n${bad} 项未达标。`); process.exit(1); }
console.log(`\n全部 ${checks.length} 项达标。`);
