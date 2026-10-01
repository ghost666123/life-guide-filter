#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify.py —— 独立验收脚本。不依赖网络，只检查已生成的产物。

用法：  python verify.py

全部通过退出码 0；任何一条不过退出码 1。
"""
import os, re, sys, json, collections

HERE  = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.html")
DATA  = os.path.join(HERE, "data", "corpus.json")

results = []
def check(name, ok, got=None, want=None):
    results.append((name, bool(ok), got, want))

# ---------- 读产物 ----------
if not os.path.exists(DATA):
    sys.exit("找不到 data/corpus.json —— 先跑 python build.py")
if not os.path.exists(INDEX):
    sys.exit("找不到 index.html")

corpus = json.load(open(DATA, encoding="utf-8"))
E, S = corpus["entries"], corpus["sections"]
html = open(INDEX, encoding="utf-8").read()

c = lambda **kw: sum(1 for e in E if all(e[k] == v for k, v in kw.items()))

# ---------- 数据完整性 ----------
check("条目总数 = 649",            len(E) == 649, len(E), 649)
check("章节数 = 34",               len(S) == 34, len(S), 34)
check("每条都有 5 维标签",          all(e["money"] and e["time"] and e["will"] and e["level"] and e["lens"] for e in E))
check("每条都有证据等级 A/B/C",      all(e["grade"] in "ABC" for e in E))
check("每条都有来源",               all(e["src"] for e in E))
check("每条都有说人话",             all(e["human"] for e in E))

# ---------- 验收基准数字 ----------
BASE = [
    ("证据等级 A = 428",        c(grade="A"), 428),
    ("证据等级 B = 171",        c(grade="B"), 171),
    ("证据等级 C = 50",         c(grade="C"), 50),
    ("不花钱 = 515",            c(money="0"), 515),
    ("花时间少 = 509",          c(time="少"), 509),
    ("不需要毅力 = 336",        c(will="否"), 336),
    ("穷+忙+没毅力 = 234",      c(money="0", time="少", will="否"), 234),
    ("　+收益大 = 111",         c(money="0", time="少", will="否", level="大"), 111),
    ("收益大+不花钱 = 267",     c(level="大", money="0"), 267),
    ("口径 死亡率 = 228",       c(lens="死亡率"), 228),
    ("口径 金钱 = 240",         c(lens="金钱"), 240),
    ("口径 自由 = 108",         c(lens="自由"), 108),
    ("口径 时间 = 73",          c(lens="时间"), 73),
]
for name, got, want in BASE:
    check(name, got == want, got, want)

# ---------- 派生字段 ----------
r = collections.Counter(e["ratio"] for e in E)
check("性价比档只有 极高/高/一般", set(r) <= {"极高", "高", "一般"}, sorted(r))
check("　极高 + 高 + 一般 = 649", sum(r.values()) == 649, sum(r.values()))
check("带批注的证据等级 = 5", sum(1 for e in E if e["gradeNote"]), sum(1 for e in E if e["gradeNote"]), 5)
check("有争议条目 = 5", sum(1 for e in E if e["dispute"]), sum(1 for e in E if e["dispute"]), 5)

# ---------- 离线自足性（核心产品承诺）----------
check("index.html 内联了语料块", '<script type="application/json" id="corpus">' in html)
check("没有 fetch( —— 断网可用", "fetch(" not in html)
check("没有 XMLHttpRequest",      "XMLHttpRequest" not in html)
check("没有外链脚本",             not re.search(r'<script[^>]+src=', html))
check("没有外链样式",             not re.search(r'<link[^>]+stylesheet', html))

# ---------- 许可合规（CC BY 4.0 三项：署名 + 许可链接 + 标注改动）----------
check("署名 原作者 eternity4719",  "eternity4719" in html)
check("许可链接 creativecommons",  "creativecommons.org/licenses/by/4.0" in html)
check("标注了改动",               "改编作品" in html or "改动" in html)
check("页脚有免责声明",           "不构成" in html)

# ---------- 输出 ----------
print(f"\n{'结果':<4}{'检查项':<32}{'实际'}")
print("─" * 74)
bad = 0
for name, ok, got, want in results:
    mark = "✓" if ok else "✗"
    extra = ""
    if not ok:
        extra = f"   ← 实际 {got}" + (f"，应为 {want}" if want is not None else "")
        bad += 1
    print(f"{mark:<4}{name:<32}{'' if ok else ''}{extra}")

print("─" * 74)
sz = os.path.getsize(INDEX) / 1024
if bad:
    print(f"{bad} / {len(results)} 条未通过。")
    sys.exit(1)
print(f"全部 {len(results)} 条通过。  index.html = {sz:,.0f} KB（单文件，可离线）")
