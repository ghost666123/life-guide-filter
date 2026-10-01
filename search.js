/* ─────────────────────────────────────────────────────────────
   search.js —— 建议搜索内核
   纯函数，无 DOM 依赖。浏览器里由 build.py 内联进 index.html，
   Node 里由 test-search.js 直接 require —— 两边跑的是同一份代码。

   为什么不用「整串子串匹配」：
     用户输入「手机丢了怎么办」，书里写「手机丢了按这个顺序做」，
     整串匹配返回 0 条。实测 30 个口语问题里 27 个零结果，
     其中 96% 是书里明明有、只是搜不到。

   三段式：
     ① 双字组合 + IDF  —— 「怎么」「怎么办」这类虚词自然权重极低，不用停用词表
     ② 口语同义词表    —— 「室友」在书里叫「人际」，「被裁」在书里叫「经济补偿」
     ③ 两个关键修正
        · 书里根本没有的词不计满权重（否则一个 OOV 词把整体分数拖死）
        · 整串命中直接置顶，且标题命中 > 正文命中
   ───────────────────────────────────────────────────────────── */
(function (root) {
  "use strict";

  var CJK = /[\u4e00-\u9fff]/;

  // 去掉不承载检索意义的填充词。
  // 注意：不要剥单字「了」—— 它会把「老了」拆成「老」、「丢了」拆成「丢」，
  // 反而破坏同义词匹配。多字词照常剥。
  var FILL = ["怎么办", "怎么", "请问", "我该", "该不该", "要不要", "能不能", "可以吗",
              "值不值", "划不划算", "好不好", "什么", "如何", "哪些", "吗", "呢", "啊", "呀"];
  var FILL_CHAR = [];

  /* 口语 → 书里的说法。改这张表就能提升召回，不用动正文一个字。 */
  var SYN = {
    "室友": ["人际", "关系", "合租"], "舍友": ["人际", "关系"],
    "抢功": ["同事", "领导", "上级"], "同事": ["同事", "单位"],
    "催婚": ["结婚", "彩礼", "长辈"], "催我": ["结婚", "长辈"], "我妈": ["结婚", "长辈", "家长"],
    "牙疼": ["牙", "口腔", "刷牙"], "牙痛": ["牙", "口腔"], "看牙": ["牙", "口腔", "补牙"],
    "考研": ["考研", "升学", "学历", "在读"], "读研": ["考研", "升学", "学历"],
    "活着没意思": ["自杀", "抑郁", "心理"], "想死": ["自杀", "抑郁", "心理"],
    "没意思": ["自杀", "抑郁", "心理", "意义"], "崩溃": ["自杀", "抑郁", "心理"],
    "借钱不还": ["欠款", "借款", "债务", "要账"], "欠钱不还": ["欠款", "借款", "债务"],
    "不还": ["欠款", "欠了", "要账"],
    "老板": ["单位", "公司", "用人单位"], "上司": ["单位", "领导"],
    "公司": ["单位", "用人单位"], "上班": ["在职", "单位", "劳动"],
    "薪水": ["工资", "薪酬"], "辞退": ["辞退", "被裁", "解除劳动", "经济补偿"],
    "开除": ["辞退", "被裁", "解除劳动"], "裁了": ["被裁", "辞退", "解除劳动", "经济补偿"],
    "欠薪": ["欠薪", "工资", "劳动监察"], "拖工资": ["欠薪", "工资", "劳动监察"],
    "房东": ["房东", "租金", "押金", "租房"], "租房": ["房东", "租金", "押金"],
    "生病": ["医保", "看病", "医院"], "看病": ["医保", "医院", "就医"],
    "异地": ["异地", "备案", "医保"],
    "分手": ["恋爱", "伴侣"], "被骗": ["诈骗", "骗局"],
    "加班": ["加班费", "工时"], "失眠": ["睡", "作息", "精力"],
    "睡不着": ["睡", "作息"], "熬夜": ["熬夜", "睡", "作息"],
    "减肥": ["减肥", "体重", "外形"], "抽烟": ["戒烟", "烟"], "喝酒": ["酒"],
    "体检": ["体检", "筛查"], "存钱": ["储蓄", "存款", "理财", "攒钱"],
    "理财": ["理财", "投资", "存款"], "股票": ["股票", "投资"],
    "生孩子": ["生孩子", "生育", "养孩子"], "买房": ["买房", "房"],
    "签证": ["签证", "出国", "留学"], "留学": ["留学", "出国", "签证"],
    "老人": ["老人", "长辈"], "父母": ["父母", "长辈", "老人"],
    "借钱": ["借款", "欠款", "债务"], "不还钱": ["欠款", "要账", "起诉"],
    "身份证": ["身份证", "补办"], "银行卡": ["银行卡", "冻结", "盗刷"],
    "诈骗电话": ["诈骗", "骗子"], "着火": ["火灾", "火"], "溺水": ["溺水", "急救"]
  };

  /* 安全类查询：书里有专门条目，必须能命中 */
  var CRISIS_RE = /自杀|抑郁|心理|活着|没意思|想死|不想活|绝望|轻生|自残/;
  var CRISIS_TITLE = /自杀|抑郁|12356|心理援助/;
  var CRISIS_HIT = /自杀|抑郁|心理|12356/;

  function bigrams(s) {
    var cs = [], i;
    for (i = 0; i < s.length; i++) if (CJK.test(s[i])) cs.push(s[i]);
    var out = [];
    for (i = 0; i < cs.length - 1; i++) out.push(cs[i] + cs[i + 1]);
    return out;
  }

  function core(q) {
    var s = String(q).toLowerCase(), i;
    for (i = 0; i < FILL.length; i++) s = s.split(FILL[i]).join("");
    for (i = 0; i < FILL_CHAR.length; i++) s = s.split(FILL_CHAR[i]).join("");
    return s.trim();
  }

  /* 预处理语料。只做一次。 */
  function buildIndex(entries) {
    var df = Object.create(null), i, j, g, set;
    for (i = 0; i < entries.length; i++) {
      var e = entries[i];
      // ★ 章节名进检索范围：用户会搜「出国留学」「押金」这类章名，
      //   那些字只出现在章名里，不在任何条目正文里。
      //   但章名是弱信号 —— 命中章名只算部分分，免得整章 44 条一起涌上来。
      e._body = [e.title, e.human, e.cost, e.gain, e.note, e.src, e.grade]
                  .join("\n").toLowerCase();
      e._sn = String(e.sn || "").toLowerCase();
      e._hay = e._sn + "\n" + e._body;
      e._ttl = String(e.title).toLowerCase();
      set = {};
      var bs = bigrams(e._hay);
      for (j = 0; j < bs.length; j++) set[bs[j]] = 1;
      for (g in set) df[g] = (df[g] || 0) + 1;
    }
    return { df: df, N: entries.length };
  }

  function idf(g, ix) {
    return Math.log((ix.N + 1) / ((ix.df[g] || 0) + 1));
  }

  var OOV_W = 0.15;   // 书里没有的词，只按这个比例计入分母
  /* 命中分档：位置（标题 > 正文）比「字面命中 vs 同义词命中」更能说明相关度。
     实测：「失眠」三个字真的出现在一条讲咖啡的正文里，如果字面命中给满分，
     它就会压过标题写着「作息固定」的那条 —— 而后者才是用户要的。 */
  var T_TTL_DIRECT = 1.00;  // 标题里字面命中
  var T_TTL_SYN    = 0.85;  // 标题里同义词命中
  var T_BODY_DIRECT= 0.70;  // 正文里字面命中
  var T_BODY_SYN   = 0.45;  // 正文里同义词命中
  var T_SN_DIRECT  = 0.68;  // 只在章名里
  var TOT_FLOOR = 0.25;     // 分母下限（见下）
  var THR   = 0.40;         // 低于这个分数不返回

  /* 返回 [{score, entry}]，已排序。core 为空或零命中返回 []。 */
  function search(q, entries, ix, opts) {
    opts = opts || {};
    var thr = opts.thr == null ? THR : opts.thr;
    var floor = opts.floor == null ? TOT_FLOOR : opts.floor;
    var c = core(q);
    var toks = [], i, g;

    // ★ 必须用去掉填充词之后的 core 来分词。
    //   用原始查询的话，「怎么办」会裂成「怎么」「么办」两个 token，
    //   而它们几乎匹配所有条目 —— 分数被整体抬高，无关条目就冒上来了。
    var bs = bigrams(c);
    for (i = 0; i < bs.length; i++) {
      g = bs[i];
      var direct = {}; direct[g] = 1;
      var syn = null;
      for (var k in SYN) {
        if (k.indexOf(g) >= 0) {
          syn = syn || {};
          var vs = SYN[k];
          for (var v = 0; v < vs.length; v++) {
            var sg = bigrams(vs[v]);
            for (var w = 0; w < sg.length; w++) if (sg[w] !== g) syn[sg[w]] = 1;
          }
        }
      }
      // df ≤ 1 的 bigram 基本是跨词拼接的产物（「出国留学要注意」里切出的
      // 「学要」），不是真词 —— 当生词处理，别让它拖低分母。
      toks.push({ w: idf(g, ix), d: direct, s: syn, known: (ix.df[g] || 0) >= 2 });
    }
    if (!toks.length) return [];

    var tot = 0, totRaw = 0;
    for (i = 0; i < toks.length; i++) {
      totRaw += toks[i].w;
      tot += toks[i].known ? toks[i].w : toks[i].w * OOV_W;
    }
    // ★ 分母下限：查询很短又全是生词时，tot 会塌陷到极小，
    //   于是一堆条目同时封顶 1.0，最后只能靠性价比随机挑 —— 结果就是
    //   「失眠」的第一条变成「每天喝三到四杯咖啡」。给个下限压住。
    if (tot < totRaw * floor) tot = totRaw * floor;
    if (tot <= 0) tot = 1;

    var crisis = CRISIS_RE.test(q);
    var res = [];
    for (i = 0; i < entries.length; i++) {
      var e = entries[i], got = 0;
      for (var t = 0; t < toks.length; t++) {
        var tk = toks[t], w = 0, ttlD = false, bodyD = false, snD = false;
        for (var dk in tk.d) {
          if (e._ttl.indexOf(dk) >= 0) ttlD = true;
          else if (e._body.indexOf(dk) >= 0) bodyD = true;
          else if (e._sn.indexOf(dk) >= 0) snD = true;
        }
        if (ttlD)       { got += tk.w * T_TTL_DIRECT;  continue; }
        if (bodyD)      { got += tk.w * T_BODY_DIRECT; continue; }
        if (snD)        { got += tk.w * T_SN_DIRECT;   continue; }
        if (tk.s) {
          var ttlS = false, bodyS = false;
          for (var sk in tk.s) {
            if (e._ttl.indexOf(sk) >= 0) ttlS = true;
            else if (e._body.indexOf(sk) >= 0) bodyS = true;
          }
          if (ttlS) got += tk.w * T_TTL_SYN;
          else if (bodyS) got += tk.w * T_BODY_SYN;
        }
      }
      // 分数不封顶：封顶会让强命中（标题）和弱命中（正文）并列，
      // 最后只能靠性价比随机挑。
      // 整串命中不再单独加分 —— 上面的分档已经表达了「标题 > 正文」，
      // 再加一次会重复计分，把正文里顺带提到关键词的条目又抬回去。
      var sc = got / tot;
      if (crisis) {
        if (CRISIS_TITLE.test(e._ttl)) sc += 0.75;        // 标题直接是危机条目 → 顶到最前
        else if (CRISIS_HIT.test(e._hay)) sc += 0.30;     // 正文提到 → 稍加权
      }
      if (sc >= thr) res.push({ score: sc, entry: e });
    }
    res.sort(compare);
    return res;
  }

  var RR = { "极高": 0, "高": 1, "一般": 2 }, GR = { A: 0, B: 1, C: 2 };
  /* 同分时保留性价比 / 证据等级排序 —— 搜索只负责把对的捞上来，不推翻作者的排序 */
  function compare(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var d = RR[a.entry.ratio] - RR[b.entry.ratio]; if (d) return d;
    d = GR[a.entry.grade] - GR[b.entry.grade];     if (d) return d;
    return (a.entry.sec - b.entry.sec) || (a.entry.n - b.entry.n);
  }

  root.SearchCore = {
    buildIndex: buildIndex,
    search: search,
    bigrams: bigrams,
    core: core,
    SYN: SYN,
    THR: THR
  };
})(typeof window !== "undefined" ? window : globalThis);
