/* ─────────────────────────────────────────────────────────────
   search.js —— 建议搜索内核
   纯函数，无 DOM 依赖。浏览器里由 build.py 内联进 index.html，
   Node 里由 test-search.js 直接 require —— 两边跑的是同一份代码。

   为什么不用「整串子串匹配」：
     用户输入「手机丢了怎么办」，书里写「手机丢了按这个顺序做」，
     整串匹配返回 0 条。

   ── 评分模型（v3）─────────────────────────────────────────────
     只在查询里【信息量最高的 K 个已知 token】上打分：

       取 token   = 已知 token（书里出现过的）按 IDF 降序取前 K 个
       分母 denom = 这 K 个 token 的 IDF 之和
       分子 got   = 这 K 个 token 各自命中时的「IDF × 分档系数」之和
       分数 sc    = got / denom          ← 恒在 0~1，不会超过 1

   v1 错在哪（两个会计错误，方向相反）：
     ① 分母 = 全部 token 的 IDF 之和 → 分数 ≈ 覆盖率，分母随查询长度线性增长。
        长句数学上注定过不了阈值。实测「被裁了而且没钱交房租」的最佳条目
        算到 0.386，被 0.40 的线丢掉 —— 正确答案算出来了，然后扔了。
        而长句正是真人的打字方式。
     ② OOV token 只给分母打 0.15 折，分子仍给满分 → 分子分母不对称，
        分数能超过 1。「被裁」3 条，「被裁了」84 条。

   v2 又错在哪：
     只把分母限制成 top-K，分子仍累计【所有】命中 token。
     于是多加一个常见词就白送分数：「被公司裁了」141 条，「被裁」3 条。
     现在分子分母用同一批 token，对称了，sc ≤ 1。

   为什么 OOV token 完全不参与：
     用户说的词书里没有，不该扣他的分。但如果直接丢掉，
     「裁了」这种书里不写的大白话会让整条查询塌成只剩「公司」一个常见词，
     结果匹配到全站。所以 OOV 的 bigram 会退化成【它那个更罕见的单字】
     （裁了 → 裁），保留信号又不引入噪声。
   ───────────────────────────────────────────────────────────── */
(function (root) {
  "use strict";

  var CJK = /[\u4e00-\u9fff]/;
  var ASCII_WORD = /[a-z0-9]+/g;

  // 去掉不承载检索意义的填充词。
  // 注意：不要剥单字「了」—— 它会把「老了」拆成「老」、「丢了」拆成「丢」，
  // 反而破坏同义词匹配。多字词照常剥。
  //
  // 第二组是连词/副词/时间词。它们本身是「真词」（绑定率很高），所以绑定过滤器
  // 拦不住，却会占掉 top-3 分母 —— 实测「被裁了而且没钱交房租」的分母里
  // 「而且」排第二(2.16)，把「被裁」挤出了分母。剥掉它们还有额外好处：
  // 被连词打断的真词会重新接上（「被裁了」+「没钱」→「被裁」「没钱」）。
  var FILL = ["怎么办", "怎么", "请问", "我该", "该不该", "要不要", "能不能", "可以吗",
              "值不值", "划不划算", "好不好", "什么", "如何", "哪些", "吗", "呢", "啊", "呀",
              "而且", "但是", "不过", "因为", "所以", "如果", "虽然", "然后", "就是",
              "还是", "或者", "以及", "并且", "可是", "于是", "现在", "已经", "一直",
              "突然", "后来", "最后", "当时", "今年", "去年", "上周", "上个月", "这个", "那个"];
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
    "公司": ["单位", "用人单位", "在职"], "上班": ["在职", "单位", "劳动"],
    "薪水": ["工资", "薪酬"], "辞退": ["辞退", "被裁", "解除劳动", "经济补偿"],
    "开除": ["辞退", "被裁", "解除劳动"], "裁了": ["被裁", "裁员", "辞退", "解除劳动", "经济补偿"],
    "辞了": ["被裁", "辞退", "离职", "经济补偿"],
    "炒了": ["被裁", "辞退", "解除劳动", "经济补偿"], "优化掉": ["被裁", "辞退", "经济补偿"],
    "裸辞": ["离职", "辞职", "失业", "失业保险"],
    "欠薪": ["欠薪", "工资", "劳动监察"], "拖工资": ["欠薪", "工资", "劳动监察"],
    "押金": ["押金", "租金", "房东", "租房"], "房东": ["房东", "租金", "押金", "租房"],
    "租房": ["房东", "租金", "押金"], "涨租": ["租金", "房东", "租房"], "房租": ["租金", "租房", "房东"],
    "生病": ["医保", "看病", "医院"], "看病": ["医保", "医院", "就医"],
    "异地": ["异地", "备案", "医保"],
    "分手": ["恋爱", "伴侣"], "被骗": ["诈骗", "骗局"],
    "加班": ["加班费", "工时"], "失眠": ["睡", "作息", "精力"],
    "睡不着": ["睡", "作息"], "熬夜": ["熬夜", "睡", "作息"],
    "减肥": ["减肥", "体重", "外形"], "抽烟": ["戒烟", "烟"], "喝酒": ["酒"],
    "体检": ["体检", "筛查"], "存钱": ["储蓄", "存款", "理财", "攒钱"],
    "理财": ["理财", "投资", "存款"], "股票": ["股票", "投资"],
    "生孩子": ["生孩子", "生育", "养孩子"], "买房": ["买房", "房", "房贷"],
    "签证": ["签证", "出国", "留学"], "留学": ["留学", "出国", "签证"],
    "老人": ["老人", "长辈"], "父母": ["父母", "长辈", "老人"],
    "借钱": ["借款", "欠款", "债务"], "不还钱": ["欠款", "要账", "起诉"],
    "身份证": ["身份证", "补办"], "银行卡": ["银行卡", "冻结", "盗刷"],
    "信用卡": ["信用卡", "逾期", "还不上"], "还不上": ["还不上", "逾期", "债务", "欠款"],
    "诈骗电话": ["诈骗", "骗子"], "着火": ["火灾", "火"], "溺水": ["溺水", "急救"],
    "社保": ["社保", "医保", "养老"], "五险一金": ["社保", "公积金"],
    "房贷": ["房贷", "贷款", "还款"], "欠债": ["债务", "欠款", "还不上"],
    "出事": ["交通", "事故", "急救"], "事故": ["交通", "事故", "保险"],
    "抚养权": ["离婚", "抚养", "孩子"], "离婚": ["离婚", "抚养", "财产"],
    "照顾": ["照顾", "监护", "老人"], "养老": ["养老", "老人", "监护"],
    "离职": ["离职", "辞职", "失业保险"], "辞职": ["辞职", "离职", "失业保险"],

    /* ── 外来词 / 网络黑话 ────────────────────────────────────────
       一类真缺口，不是调参能解决的：书是中文写的，不会出现 PUA、offer
       这类词。用户（尤其刚毕业的）天天在用。只能靠这张表映射回书里的说法。 */
    "pua": ["精神控制", "恋爱", "尊重", "伴侣"], "内卷": ["竞争", "加班", "工时"],
    "躺平": ["低欲望", "存钱", "生活成本"], "裸辞": ["离职", "辞职", "失业保险"],
    "offer": ["录用", "求职", "入职", "签合同"], "996": ["加班", "工时", "加班费"],
    "gap": ["失业", "求职", "离职"], "裁员": ["被裁", "辞退", "经济补偿", "解除劳动"],
    "优化": ["被裁", "辞退", "经济补偿"], "大厂": ["单位", "公司", "在职"],
    "降薪": ["工资", "薪酬", "欠薪"], "副业": ["兼职", "收入", "赚钱"],
    "上岸": ["考公", "编制", "考研"], "考公": ["编制", "公务员"],
    "医美": ["整形", "外形", "医美"], "植发": ["脱发", "外形"],
    "社恐": ["人际", "社交", "心理"], "抑郁": ["抑郁", "心理", "12356"],
    "焦虑": ["心理", "抑郁", "作息"], "破防": ["心理", "抑郁"],
    "断供": ["房贷", "还款", "逾期"], "征信": ["征信", "逾期", "信用卡"],
    "减重": ["减肥", "体重"], "掉秤": ["减肥", "体重"],
    "压金": ["押金", "租金", "房东"], "押金条": ["押金", "租金"]
  };

  /* 安全类查询：书里有专门条目，必须能命中，而且必须是【求助】那条排最前，
     不能是讲「亲人自杀后怎么走出来」的哀伤条目。 */
  var CRISIS_RE    = /自杀|抑郁|心理|活着|没意思|想死|不想活|绝望|轻生|自残|死/;
  var CRISIS_TOP   = /12356|心理援助|抑郁|自杀念头|心理危机/;   // 求助热线/就医 → 顶格
  var CRISIS_TITLE = /自杀|抑郁|心理|12356/;                    // 相关但次一级

  function cjkChars(s) {
    var out = [], i;
    for (i = 0; i < s.length; i++) if (CJK.test(s[i])) out.push(s[i]);
    return out;
  }
  function bigrams(s) {
    var cs = cjkChars(s), out = [], i;
    for (i = 0; i < cs.length - 1; i++) out.push(cs[i] + cs[i + 1]);
    return out;
  }
  function asciiWords(s) {
    var m = String(s).toLowerCase().match(ASCII_WORD);
    return m ? m.filter(function (w) { return w.length >= 2; }) : [];
  }

  function core(q) {
    var s = String(q).toLowerCase(), i;
    for (i = 0; i < FILL.length; i++) s = s.split(FILL[i]).join("");
    for (i = 0; i < FILL_CHAR.length; i++) s = s.split(FILL_CHAR[i]).join("");
    return s.trim();
  }

  /* 预处理语料。只做一次。 */
  function buildIndex(entries) {
    var df = Object.create(null), df1 = Object.create(null), dfw = Object.create(null);
    var dft = Object.create(null);
    var i, j, g, set, e, bs;
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      // ★ 章节名进检索范围：用户会搜「出国留学」「押金」这类章名，
      //   那些字只出现在章名里，不在任何条目正文里。
      //   但章名是弱信号 —— 命中章名只算部分分（见 T_SN_DIRECT），
      //   免得整章 44 条一起涌上来。
      e._body = [e.title, e.human, e.cost, e.gain, e.note, e.src, e.grade]
                  .join("\n").toLowerCase();
      e._sn = String(e.sn || "").toLowerCase();
      e._hay = e._sn + "\n" + e._body;
      e._ttl = String(e.title).toLowerCase();

      set = {};
      bs = bigrams(e._hay);
      for (j = 0; j < bs.length; j++) set[bs[j]] = 1;
      for (g in set) df[g] = (df[g] || 0) + 1;

      // 只统计标题：标题是人手写的短语，跨词拼接的假词永远进不去。
      // 这是「真词还是假词」最干净的判据 —— 比值阈值分不开「被裁」(0.115)
      // 和「纪大」(0.182)，但「被裁」出现在标题里，「纪大」不会。
      set = {};
      bs = bigrams(e._ttl);
      for (j = 0; j < bs.length; j++) set[bs[j]] = 1;
      for (g in set) dft[g] = (dft[g] || 0) + 1;

      set = {};
      var cs = cjkChars(e._hay);
      for (j = 0; j < cs.length; j++) set[cs[j]] = 1;
      for (g in set) df1[g] = (df1[g] || 0) + 1;

      set = {};
      var ws = asciiWords(e._hay);
      for (j = 0; j < ws.length; j++) set[ws[j]] = 1;
      for (g in set) dfw[g] = (dfw[g] || 0) + 1;
    }
    return { df: df, df1: df1, dfw: dfw, dft: dft, N: entries.length };
  }

  function idf(g, ix)  { return Math.log((ix.N + 1) / ((ix.df[g]  || 0) + 1)); }
  function idf1(g, ix) { return Math.log((ix.N + 1) / ((ix.df1[g] || 0) + 1)); }
  function idfw(g, ix) { return Math.log((ix.N + 1) / ((ix.dfw[g] || 0) + 1)); }

  /* 命中分档：位置（标题 > 正文）比「字面命中 vs 同义词命中」更能说明相关度。
     实测：「失眠」三个字真的出现在一条讲咖啡的正文里，如果字面命中给满分，
     它就会压过标题写着「作息固定」的那条 —— 而后者才是用户要的。 */
  var T_TTL_DIRECT = 1.00;  // 标题里字面命中
  var T_TTL_SYN    = 0.80;  // 标题里同义词命中
  var T_BODY_DIRECT= 0.45;  // 正文里字面命中
  var T_BODY_SYN   = 0.22;  // 正文里同义词命中
  var T_SN_DIRECT  = 0.35;  // 只在章名里
  var TOPN = 3;             // 只在 IDF 最高的这几个已知 token 上打分
  var THR  = 0.40;          // 低于这个分数不返回
  var SINGLE_W = 0.35;      // OOV bigram 退化成单字时的折扣（单字比双字弱）
  var BIND_MIN = 0.10;      // bigram 绑定率下限，用来滤掉「尾字+首字」拼出的假词

  function synFor(g) {
    var syn = null, k, vs, v, sg, w;
    for (k in SYN) {
      if (k.indexOf(g) >= 0) {
        syn = syn || {};
        vs = SYN[k];
        for (v = 0; v < vs.length; v++) {
          sg = bigrams(vs[v]);
          for (w = 0; w < sg.length; w++) if (sg[w] !== g) syn[sg[w]] = 1;
          if (!sg.length && vs[v].length === 1) syn[vs[v]] = 1;
        }
      }
    }
    return syn;
  }

  /* 跨词拼接的假词滤除。
     「我上个月被裁员了」会切出 bigram「月被」—— 前一个词的尾字 + 后一个词的首字。
     它在 2 条条目里碰巧出现过，于是拿到最高 IDF 挤进 top-3 分母，
     把真信号（被裁）压到阈值以下 —— 整条查询就废了。
     判据用两个条件【同时】成立：
      ① 绑定率达标 —— 这个 bigram 的条目数要接近它那个更罕见单字的条目数
         （几乎每条带「裁」的条目都写着「被裁」）；假词远低于两者。
      ② 出现在某条标题里 —— 标题是人手写的短语，假词进不去。
    两个都要，是因为各自都不够：
      只看 ① 分不开「被裁」(.115，真) 和「纪大」(.182，假) —— 区间是交叉的；
      只看 ② 又太宽，「个月」也出现在标题里（「不满六个月按半个月」），
      但它是个片段，不是主题词，混进分母就稀释真信号。 */
  function knownBigram(g, ix) {
    if ((ix.df[g] || 0) < 2) return false;
    if ((ix.dft[g] || 0) < 1) return false;
    var m = Math.min(ix.df1[g[0]] || 0, ix.df1[g[1]] || 0);
    return m > 0 && ((ix.df[g] || 0) / m) >= BIND_MIN;
  }
  function mkBigram(g, ix) {
    var d = {}; d[g] = 1;
    return { w: idf(g, ix), d: d, s: synFor(g), known: knownBigram(g, ix) };
  }
  function mkSingle(c, ix, w) {
    var d = {}; d[c] = 1;
    return { w: w, d: d, s: synFor(c), known: true, single: true };
  }

  /* 把查询切成 token。返回 [{w, d, s, known, single}] */
  function tokenize(q, ix) {
    var c = core(q);
    var toks = [], seen = Object.create(null), i, g, bs, cs;

    function add(t) { var k = t.single ? "1:" + Object.keys(t.d)[0] : Object.keys(t.d)[0];
                      if (!seen[k]) { seen[k] = 1; toks.push(t); } }

    bs = bigrams(c);
    if (bs.length) {
      // 先确定哪些是已知的真词，并收集它们用到的字。
      // 单字回退时必须跳过这些字：否则「被公司裁了」里的「公司」被算一次 bigram，
      // 又被「被公」「司裁」两个假词拆成「公」「司」再各算一次 —— 同一条证据
      // 计三遍，含「公司」的条目全部超线（53 条），而「被裁」只有 3 条。
      // 这就是「同一意思换个说法，条数暴涨」的来源。
      var bigToks = [], covered = Object.create(null);
      for (i = 0; i < bs.length; i++) {
        var t = mkBigram(bs[i], ix);
        bigToks.push(t);
        if (t.known) { covered[bs[i][0]] = 1; covered[bs[i][1]] = 1; }
      }
      for (i = 0; i < bigToks.length; i++) {
        add(bigToks[i]);
        if (bigToks[i].known) continue;
        // OOV 的 bigram 基本是跨词拼接的产物（「出国留学要注意」切出的「学要」），
        // 或书里不写的口语（「裁了」「存钱」「生病」）。直接丢掉会让查询塌成
        // 只剩几个常见词，匹配到全站 —— 所以两个单字都加成 token，各打一个折扣。
        // 不需要额外的稀有度门槛：常见的字（了 471 条 / 上 553 条）IDF 本来就近 0，
        // 自己就消失了。加门槛反而会把「考」「存」「病」这些有用的字一起误杀。
        if (!covered[bs[i][0]]) add(mkSingle(bs[i][0], ix, idf1(bs[i][0], ix) * SINGLE_W));
        if (!covered[bs[i][1]]) add(mkSingle(bs[i][1], ix, idf1(bs[i][1], ix) * SINGLE_W));
      }
    } else {
      // 没有双字组合：单字查询（「死」「钱」「房」）或纯英文/符号。
      // v1 在这里直接返回空数组，导致单字查询恒为 0 条 —— 包括「死」，
      // 安全兜底因此完全失效。
      cs = cjkChars(c);
      for (i = 0; i < cs.length; i++) add(mkSingle(cs[i], ix, idf1(cs[i], ix)));
    }
    // 英文/数字词始终参与（中英混排：「offer 怎么选」「被 PUA 了怎么办」）
    var ws = asciiWords(c);
    for (i = 0; i < ws.length; i++) add(mkSingle(ws[i], ix, idfw(ws[i], ix)));
    return toks;
  }

  /* 返回 [{score, entry}]，已排序。 */
  function search(q, entries, ix, opts) {
    opts = opts || {};
    var thr = opts.thr == null ? THR : opts.thr;
    var topn = opts.topn == null ? TOPN : opts.topn;
    var toks = tokenize(q, ix);
    if (!toks.length) return [];

    // ★ 分子分母用同一批 token：已知 token 里 IDF 最高的 K 个。
    //   两边对称，sc 恒在 0~1，多加一个常见词不会白送分数。
    var known = [];
    for (var t = 0; t < toks.length; t++) if (toks[t].known) known.push(toks[t]);
    if (!known.length) return [];
    known.sort(function (a, b) { return b.w - a.w; });
    var picked = known.slice(0, topn);
    var denom = 0;
    for (var k = 0; k < picked.length; k++) denom += picked[k].w;
    if (denom <= 0) return [];

    var crisis = CRISIS_RE.test(q);
    var res = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], got = 0;
      for (var x = 0; x < picked.length; x++) {
        var tk = picked[x], ttlD = false, bodyD = false, snD = false, dk;
        for (dk in tk.d) {
          if (e._ttl.indexOf(dk) >= 0) ttlD = true;
          else if (e._body.indexOf(dk) >= 0) bodyD = true;
          else if (e._sn.indexOf(dk) >= 0) snD = true;
        }
        if (ttlD)       { got += tk.w * T_TTL_DIRECT;  continue; }
        if (bodyD)      { got += tk.w * T_BODY_DIRECT; continue; }
        if (snD)        { got += tk.w * T_SN_DIRECT;   continue; }
        if (tk.s) {
          var ttlS = false, bodyS = false, sk;
          for (sk in tk.s) {
            if (e._ttl.indexOf(sk) >= 0) ttlS = true;
            else if (e._body.indexOf(sk) >= 0) bodyS = true;
          }
          if (ttlS) got += tk.w * T_TTL_SYN;
          else if (bodyS) got += tk.w * T_BODY_SYN;
        }
      }
      var sc = got / denom;
      if (crisis) {
        if (CRISIS_TOP.test(e._ttl))        sc += 3.0;   // 求助热线/就医那条顶到最前
        else if (CRISIS_TITLE.test(e._ttl)) sc += 0.9;
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
    tokenize: tokenize,
    bigrams: bigrams,
    cjkChars: cjkChars,
    asciiWords: asciiWords,
    core: core,
    SYN: SYN,
    THR: THR,
    TOPN: TOPN
  };
})(typeof window !== "undefined" ? window : globalThis);
