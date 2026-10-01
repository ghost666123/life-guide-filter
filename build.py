#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py —— 从上游仓库重新生成数据，并注入 index.html。

用法：
    python build.py              # 用本地缓存（没有就克隆）
    python build.py --update     # 强制拉取上游最新

上游：https://github.com/eternity4719/HowToLiveBetter  (CC BY 4.0)
本脚本只做解析，不改动任何正文字句。
"""
import os, re, sys, json, shutil, subprocess, collections

HERE   = os.path.dirname(os.path.abspath(__file__))
REPO   = os.path.join(HERE, ".upstream")
INDEX  = os.path.join(HERE, "index.html")
DATA   = os.path.join(HERE, "data", "corpus.json")
REMOTE = "https://github.com/eternity4719/HowToLiveBetter.git"

TAG   = re.compile(r'<!--\s*成本标签:\s*钱=(\S+?)\s+时间=(\S+?)\s+毅力=(\S+?)\s+收益=(\S+?)\s+口径=(\S+?)\s*-->')
ITEM  = re.compile(r'^###\s+(\d+)\.\s+(.+?)\s*$')
SEC   = re.compile(r'^#\s+(\d+)\.\s+(.+?)\s*$')
FIELD = {k: re.compile(r'^-\s*' + k + r'：\s*(.*)$')
         for k in ["成本", "说人话", "收益", "证据等级", "来源", "备注"]}

# 作者本人在 index.html 里定义的权重，照搬以保证口径一致
COST_W = {"money": {"0": 0, "少": 1, "多": 2},
          "time":  {"少": 0, "中": 1, "多": 2},
          "will":  {"否": 0, "些": 1, "是": 2}}


def run(cmd, **kw):
    kw.setdefault("cwd", HERE)
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def fetch(update=False):
    if update and os.path.isdir(REPO):
        shutil.rmtree(REPO, ignore_errors=True)
    if not os.path.isdir(os.path.join(REPO, "book")):
        print("→ 浅克隆上游仓库 …")
        r = run(["git", "-c", "http.sslVerify=false", "clone", "--depth", "1", REMOTE, ".upstream"])
        if r.returncode:
            sys.exit("克隆失败：" + (r.stderr or r.stdout))
    sha = run(["git", "rev-parse", "HEAD"], cwd=REPO).stdout.strip()
    return sha


def parse():
    book = os.path.join(REPO, "book")
    files = sorted(f for f in os.listdir(book) if f.endswith(".md"))
    sections, entries = [], []
    for fn in files:
        m = re.match(r'^(\d+)-(.+)\.md$', fn)
        if not m:
            continue
        sec_n, sec_name = int(m.group(1)), m.group(2)
        sections.append({"n": sec_n, "name": sec_name, "file": "book/" + fn})

        cur, intro = None, []
        for raw in open(os.path.join(book, fn), encoding="utf-8").read().split("\n"):
            line = raw.rstrip()
            im = ITEM.match(line)
            if im:
                if cur:
                    entries.append(cur)
                cur = {"sec": sec_n, "n": int(im.group(1)), "title": im.group(2),
                       "money": "", "time": "", "will": "", "level": "", "lens": "",
                       "cost": "", "human": "", "gain": "", "grade": "", "src": "", "note": ""}
                continue
            if cur is None:
                if line and not line.startswith(("<!--", "<")):
                    intro.append(line)
                continue
            tm = TAG.search(line)
            if tm:
                cur["money"], cur["time"], cur["will"], cur["level"], cur["lens"] = tm.groups()
                continue
            hit = False
            for k, rx in FIELD.items():
                fm = rx.match(line)
                if fm:
                    key = {"成本": "cost", "说人话": "human", "收益": "gain",
                           "证据等级": "grade", "来源": "src", "备注": "note"}[k]
                    cur[key] = (cur[key] + " " + fm.group(1)).strip() if cur[key] else fm.group(1).strip()
                    hit = True
                    break
            if not hit and line.startswith("-  "):     # 续行
                pass
        if cur:
            entries.append(cur)
        sections[-1]["intro"] = " ".join(intro)[:400]

    # ---- 派生字段（与作者 index.html 的算法一致）----
    for e in entries:
        e["cs"] = (COST_W["money"].get(e["money"], 0)
                   + COST_W["time"].get(e["time"], 0)
                   + COST_W["will"].get(e["will"], 0))
        if e["level"] == "大":
            e["ratio"] = "极高" if e["cs"] == 0 else ("高" if e["cs"] <= 2 else "一般")
        elif e["level"] == "中":
            e["ratio"] = "高" if e["cs"] == 0 else "一般"
        else:
            e["ratio"] = "一般"
        # 证据等级可能带批注，如 "A（争议）"、"B（指南强推荐，但底层证据等级低）"
        # 取首字母当等级，其余存进 gradeNote —— 作者的标注不能丢。
        gm = re.match(r'^\s*([ABC])\s*(.*)$', e["grade"] or "")
        e["gradeNote"] = gm.group(2).strip("（）() 　").strip() if gm else ""
        e["grade"] = gm.group(1) if gm else ""
        e["dispute"] = ("争议" in e["gradeNote"]) or e["note"].startswith("争议")
        e["todo"] = bool(re.search(r'待核实|TODO', e["src"] + e["gain"] + e["note"] + e["cost"]))
    return sections, entries


def verify(entries, sections):
    """验收断言。任何一条不过就中止，不写文件。"""
    c = lambda **kw: sum(1 for e in entries if all(e[k] == v for k, v in kw.items()))
    checks = [
        ("条目总数 = 649",              len(entries) == 649, len(entries)),
        ("章节数 = 34",                 len(sections) == 34, len(sections)),
        ("标签覆盖率 = 100%",           c(money="0") + c(money="少") + c(money="多") == len(entries), "-"),
        ("证据等级 A = 428",            c(grade="A") == 428, c(grade="A")),
        ("证据等级 B = 171",            c(grade="B") == 171, c(grade="B")),
        ("证据等级 C = 50",             c(grade="C") == 50,  c(grade="C")),
        ("不花钱 = 515",                c(money="0") == 515, c(money="0")),
        ("花时间少 = 509",              c(time="少") == 509, c(time="少")),
        ("不需要毅力 = 336",            c(will="否") == 336, c(will="否")),
        ("穷+忙+没毅力 = 234",          c(money="0", time="少", will="否") == 234, c(money="0", time="少", will="否")),
        ("　+收益大 = 111",             c(money="0", time="少", will="否", level="大") == 111, c(money="0", time="少", will="否", level="大")),
        ("口径 死亡率 = 228",           c(lens="死亡率") == 228, c(lens="死亡率")),
        ("口径 金钱 = 240",             c(lens="金钱") == 240, c(lens="金钱")),
        ("口径 自由 = 108",             c(lens="自由") == 108, c(lens="自由")),
        ("口径 时间 = 73",              c(lens="时间") == 73,  c(lens="时间")),
        ("每条都有证据等级",            sum(1 for e in entries if e["grade"]) == len(entries),
                                        sum(1 for e in entries if e["grade"])),
    ]
    print("\n验收断言：")
    bad = 0
    for name, ok, got in checks:
        print(f"  {'✓' if ok else '✗'} {name}" + ("" if ok else f"   ← 实际 {got}"))
        bad += not ok
    if bad:
        sys.exit(f"\n{bad} 条断言未通过，已中止，未写入任何文件。")
    print(f"  全部 {len(checks)} 条通过。")


def main():
    sha = fetch("--update" in sys.argv)
    sections, entries = parse()
    verify(entries, sections)

    corpus = {
        "meta": {"count": len(entries), "sections": len(sections),
                 "source": "https://github.com/eternity4719/HowToLiveBetter",
                 "license": "CC BY 4.0", "commit": sha,
                 "generated": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M")},
        "sections": sections,
        "entries": entries,
    }
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(DATA, "w", encoding="utf-8") as f:
        json.dump(corpus, f, ensure_ascii=False, separators=(",", ":"))

    # ---- 注入 index.html ----
    html = open(INDEX, encoding="utf-8").read()
    blob = json.dumps(corpus, ensure_ascii=False, separators=(",", ":"))
    new, n = re.subn(r'(<script type="application/json" id="corpus">)(.*?)(</script>)',
                     lambda m: m.group(1) + blob + m.group(3), html, flags=re.S)
    if not n:
        sys.exit("index.html 里找不到 corpus 数据块，注入失败。")
    open(INDEX, "w", encoding="utf-8").write(new)

    print(f"\n数据版本 commit {sha[:8]}")
    print(f"  {DATA}   {os.path.getsize(DATA)/1024:,.0f} KB")
    print(f"  {INDEX}  {os.path.getsize(INDEX)/1024:,.0f} KB  （已内联，双击即可打开，无需服务器）")


if __name__ == "__main__":
    main()
