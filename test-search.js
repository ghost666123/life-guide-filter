#!/usr/bin/env node
/* 搜索验收：node test-search.js
   直接 require search.js —— 和浏览器跑的是同一份代码，不存在两套实现漂移。
   退出码 0 = 全过，1 = 有指标不达标。

   三组指标，缺一不可：
     cases     基础组（短查询）
     hard      难例组（长句/单字/英文/混排/口语/错别字）
     stability 同义改写不该让命中条数暴涨暴跌
   只测 cases 就会重演 v1 的过拟合：对着一组自己挑的短查询调到 93%，
   真人一打长句全灭。 */
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

function runGroup(name, list) {
  const rows = [];
  let oldZero = 0, badZero = 0, ok = 0, judged = 0, sumN = 0;
  const nozero = new Set(spec.must_not_be_zero || []);
  const criticalFail = [], zeroList = [];
  for (const c of list) {
    const o = oldSearch(c.q);
    const n = SC.search(c.q, E, ix);
    if (o.length === 0) oldZero++;
    // 零结果只在这两种情况下算失败：
    //   ① 我们判了首条对错（说明书里该有）  ② 显式登记为「输入类型必须支持」
    // 语料确实没有的主题（室友太吵 / 牙疼）不算失败 —— 页面会走「最接近的 3 章」兜底。
    const mustNotBeZero = !!c.expect || nozero.has(c.q);
    if (n.length === 0 && mustNotBeZero) { badZero++; zeroList.push(c.q); }
    sumN += n.length;
    let mark = "·";
    if (c.expect) {
      judged++;
      const re = new RegExp(c.expect);
      const top = n.length ? (n[0].entry.title + " " + (n[0].entry.human || "")) : "";
      const good = re.test(top);
      if (good) ok++;
      mark = good ? "✓" : "✗";
      if (!good && c.critical) criticalFail.push(c.q);
    }
    rows.push({ q: c.q, o: o.length, n: n.length, mark,
                top: n.length ? n[0].entry.title.slice(0, 44) : "—— 零 ——",
                score: n.length ? n[0].score.toFixed(2) : "" });
  }
  console.log("\n" + "═".repeat(112));
  console.log("【" + name + "】 " + list.length + " 条");
  console.log("═".repeat(112));
  console.log("输入".padEnd(26) + "旧".padStart(4) + "新".padStart(4) + " 判   分    新首条");
  console.log("─".repeat(112));
  for (const r of rows)
    console.log(r.q.padEnd(26) + String(r.o).padStart(4) + String(r.n).padStart(4) +
                "  " + r.mark + "  " + r.score.padStart(5) + "  " + r.top);
  console.log("─".repeat(112));
  console.log(`对照：旧搜索零结果 ${oldZero}/${list.length}  →  新搜索 ${badZero}/${list.length}` +
              (zeroList.length ? "   零结果：" + zeroList.join(" / ") : ""));
  return { rows, newZero: badZero, ok, judged, sumN, criticalFail, n: list.length,
           top1: judged ? ok / judged : 1, avg: sumN / list.length };
}

const base = runGroup("基础组 cases（短查询）", spec.cases);
const hard = runGroup("难例组 hard（长句/单字/英文/混排/口语）", spec.hard);

// ── 稳定性：同义改写的命中条数不该暴涨暴跌 ──────────────────────
console.log("\n" + "═".repeat(112));
console.log("【稳定性 stability】 同一意思换个说法，命中条数不该暴涨暴跌");
console.log("═".repeat(112));
const stab = [];
for (const g of spec.stability) {
  const counts = g.queries.map(q => ({ q, n: SC.search(q, E, ix).length }));
  const ns = counts.map(c => c.n);
  const lo = Math.max(1, Math.min(...ns)), hi = Math.max(...ns);
  const ratio = hi / lo;
  const lim = g.max_ratio == null ? spec.thresholds.stability_max_ratio : g.max_ratio;
  stab.push({ name: g.name, ratio, lo, hi, counts, lim });
  console.log(`  ${ratio <= lim ? "✓" : "✗"} ${g.name.padEnd(18)}` +
              `  ${lo}~${hi} 条（比值 ${ratio.toFixed(1)} ≤ ${lim}）   ` +
              counts.map(c => `${c.q}=${c.n}`).join("  ") +
              (g.note ? "\n      ↳ " + g.note : ""));
}

const T = spec.thresholds;
const worstStab = Math.max(...stab.map(s => s.ratio / s.lim));
const critFail = base.criticalFail.concat(hard.criticalFail);

console.log("\n" + "═".repeat(112));
console.log("验收");
console.log("═".repeat(112));
const checks = [
  ["基础组 零结果 ≤ " + T.zero_result_max,           base.newZero <= T.zero_result_max, base.newZero],
  ["难例组 零结果 ≤ " + T.hard_zero_result_max,       hard.newZero <= T.hard_zero_result_max, hard.newZero],
  ["基础组 首条正确率 ≥ " + T.top1_min_ratio * 100 + "%",  base.top1 >= T.top1_min_ratio, (base.top1 * 100).toFixed(0) + "%"],
  ["难例组 首条正确率 ≥ " + T.hard_top1_min_ratio * 100 + "%", hard.top1 >= T.hard_top1_min_ratio, (hard.top1 * 100).toFixed(0) + "%"],
  ["基础组 平均返回 ≤ " + T.max_results_avg,          base.avg <= T.max_results_avg, base.avg.toFixed(0)],
  ["难例组 平均返回 ≤ " + T.hard_max_results_avg,     hard.avg <= T.hard_max_results_avg, hard.avg.toFixed(0)],
  ["稳定性 每组比值不超各自的线",                      worstStab <= 1, worstStab.toFixed(2) + " 倍"],
  ["安全类查询全部命中",                              critFail.length === 0, critFail.join(",") || "ok"]
];
let bad = 0;
for (const [name, passed, got] of checks) {
  console.log(`  ${passed ? "✓" : "✗"} ${name.padEnd(34)} 实际 ${got}`);
  if (!passed) bad++;
}
if (bad) { console.log(`\n${bad} 项未达标。`); process.exit(1); }
console.log(`\n全部 ${checks.length} 项达标。`);
