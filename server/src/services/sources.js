/**
 * 采集源配置
 *
 * 来源启用状态：
 *   - qiyoujiage（汽油价格网）：已启用。2026-11-12 完成真实抓取验证 ——
 *     省级地区页结构一致（北京/陕西/云南抽查），解析出的挂牌价与
 *     data/reference-prices.js（独立来源）逐值核对一致；页面 utf-8，
 *     无需 Referer/Cookie。站点声明价格仅供参考，展示侧必须保留来源标注。
 *   - ndrc-notice / market-quote：仍默认关闭。启用前需单独验证
 *     可访问性、字段稳定性、更新频率和授权条款。
 *
 * 硬约束（所有来源一致）：解析不出结构化字段就进人工核对队列，
 * 绝不把猜测值发布成正式结果；预测类信息必须标注非官方。
 *
 * 关闭状态下采集函数会照常跑通「读取配置 → 抓取 → 解析 → 去重 → 入库」流程，
 * 只是把每个来源标记为 skipped —— 采集运行记录里据此显示「真实数据源尚未接入」。
 */
const SOURCES = [
  {
    id: 'qiyoujiage',
    name: '汽油价格网',
    kind: 'price',
    enabled: true,
    // ⚠️ 这个站**没有** HTTPS：证书是腾讯 CDN 的通用证书，
    // altnames 里没有 qiyoujiage.com，https 握手直接失败（2026-11-13 实测）。
    // 只能走 HTTP —— 所以抓取层必须做交叉校验兜底（见 collector.js 的 saveRegionPrices）。
    url: 'http://www.qiyoujiage.com/',
    // 允许跳转的主机：站点改版跳到 CDN 域名时还能跟上，
    // 跳去别处就拒绝（避免请求被引到不可控的服务器）。
    allowedHosts: ['www.qiyoujiage.com'],
    headers: {
      // 站点按 UA 做移动版跳转，用桌面浏览器 UA 拿 PC 页（参考 60s / OilPrice 的做法）
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    parser: 'qiyoujiageRegion',
    // 地区页 = url + 地区 slug + '.shtml'，slug 真源在 data/regions.js
    // 价格只在调价日变化：freshHours 内抓过的地区跳过，不每 30 分钟打一遍全站
    freshHours: 6,
    note: '各省挂牌价 + 下次调价预测（非官方）。地区页为 utf-8 HTML'
  },
  {
    id: 'ndrc-notice',
    name: '国家发展改革委价格监测中心',
    kind: 'notice',
    enabled: false,
    url: '',
    headers: {},
    parser: 'ndrcNotice',
    note: '正式调价公告来源，需先验证可访问性与使用条款'
  },
  {
    id: 'market-quote',
    name: '国际原油行情接口',
    kind: 'market',
    enabled: false,
    url: '',
    headers: {},
    parser: 'genericQuote',
    note: 'Brent / WTI 报价，需确认是否延时、是否允许展示'
  }
];

/**
 * 通用解析器：只接受「明确匹配到数值」的结果。
 * 匹配不到就返回 null，由采集函数丢进人工核对队列，
 * 绝不用默认值或猜测值填充正式结果。
 */
const PARSERS = {
  /**
   * 解析汽油价格网地区页（如 /beijing.shtml）。
   *
   * 页面结构（2026-11-12 实测，北京/陕西/云南三省一致）：
   *   <div id="youjia">
   *     <dl><dt>北京92#汽油</dt><dd>8.89</dd></dl> × 4 个油品
   *   </div>
   *   <div style="border:solid 1px #EA5146; ...">下次油价X月X日X时调整 ... 预计...</div>
   *
   * 返回 { prices: {92,95,98,0}, trend: {...}|null }。
   * 四个油品价格缺一不可、数值必须在合理区间，否则整体返回 null 转人工；
   * 预测区块解析不出时 trend 为 null，不影响价格入库。
   *
   * @param {string} raw 页面 HTML
   * @param {number} [now] 当前时间戳（测试可注入；缺省 Date.now()）
   */
  qiyoujiageRegion(raw, now) {
    // 先去掉 HTML 注释：页尾有一段被注释掉的旧预测 div，也带 #EA5146，
    // 不剥掉会被当成现行预测解析出 2017 年的日期。
    var html = String(raw || '').replace(/<!--[\s\S]*?-->/g, '');
    var block = html.match(/<div id="youjia">([\s\S]*?)<\/div>/);
    if (!block) return null;

    var prices = {};
    var dlRe = /<dl>\s*<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>\s*<\/dl>/g;
    var m;
    while ((m = dlRe.exec(block[1])) !== null) {
      var name = stripTags(m[1]);
      var num = name.match(/(\d+)\s*[#号]/);
      if (!num) continue;
      var fuelId = { '92': '92', '95': '95', '98': '98', '0': '0' }[num[1]];
      // 90# 等本项目不展示的油品直接跳过（不能按子串匹配，"90#" 里含 "0#"）
      if (!fuelId) continue;
      var price = Number(stripTags(m[2]));
      // 挂牌价的合理区间：超出说明页面结构变了或解析错位，整体转人工
      if (!isFinite(price) || price < 3 || price > 20) return null;
      prices[fuelId] = price;
    }
    if (!prices['92'] || !prices['95'] || !prices['98'] || !prices['0']) return null;

    return { prices: prices, trend: qyjTrend(html, now) };
  },

  /**
   * 解析调价公告：从正文里找「每升调整 X 元」这类明确表述。
   * 找不到就返回 null。
   *
   * ⚠️ reviewStatus 在这里是**机器判定**的可信度标记，不是人工审核结论：
   *   approved —— 逐项幅度明确且执行日期明确，可对外发布；
   *   pending  —— 正文写法与预期不符（只解析出总幅度 / 没抓到执行日期），
   *               存疑不发布，等人工核对。
   */
  ndrcNotice(raw) {
    var text = String(raw || '').replace(/\s+/g, '');

    // ---- 1. 逐项幅度 ----
    // 正文里的典型写法是「92号汽油、95号汽油、98号汽油每升下调0.10元」：
    // 几个油品**共用一个幅度**。所以先把油品标号按位置抓出来，
    // 再看每个「每升X元」短语前面那一串标号 —— 那一串全都适用这个幅度。
    //
    // ⚠️ 之前用「标号 + 每升X元」配对，正则一匹配就吃掉整段，
    // 于是共用幅度的写法只认得下最后一个油品（98# 的幅度记到 98# 头上，
    // 92# 与 95# 直接丢了），却仍然判成「逐项解析成功」。
    var labels = [];
    var labelRe = /(^|[^0-9])(92|95|98|0)\s*[#号]\s*(?:汽油|柴油)?/g;
    var lm;
    while ((lm = labelRe.exec(text)) !== null) {
      // (^|[^0-9]) 会吃掉标号前面那个字，算真实起点时要补回来。
      // 前一位不是数字这条约束保证「90号」不会被当成「0号」。
      labels.push({ fuelId: lm[2], start: lm.index + lm[1].length, end: labelRe.lastIndex });
    }

    var deltas = {};
    var ambiguousDirection = false;
    var conflict = false;
    var prevEnd = 0;
    var amountRe = /每升(?:价格)?(上调|下调|调整)([\d.]+)元/g;
    var am;
    while ((am = amountRe.exec(text)) !== null) {
      var dir = am[1];
      var mag = Number(am[2]);
      var group = fuelGroupBefore(text, labels, prevEnd, am.index);
      prevEnd = amountRe.lastIndex;
      if (!group.length || !isFinite(mag)) continue;
      if (dir !== '上调' && dir !== '下调') {
        // 「调整」看不出方向 —— 不猜，整条判存疑。
        // （之前非「下调」一律取正，「调整0.10元」被当成**上涨**发布）
        ambiguousDirection = true;
        continue;
      }
      var value = dir === '下调' ? -mag : mag;
      group.forEach(function (g) {
        if (deltas[g.fuelId] !== undefined && deltas[g.fuelId] !== value) conflict = true;
        deltas[g.fuelId] = value;
      });
    }

    // ---- 2. 执行日期 ----
    // 只认「…24时起」这种带生效语义的写法。
    // 被「上次/上轮/此前」修饰的日期是上一轮的，不能当本轮生效日 ——
    // 之前不限语境直接取第一个匹配，「上次调价自11月1日24时起」会被当成本轮日期。
    var executeAt = null;
    var dateRe = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:24时|24:00)/g;
    var dm;
    while ((dm = dateRe.exec(text)) !== null) {
      var before = text.slice(Math.max(0, dm.index - 16), dm.index);
      if (/上次|上轮|此前|前次|上一轮/.test(before)) continue;
      // 取最后一个：本轮生效日总在上一轮之后
      executeAt = dm[1] + '-' + pad(dm[2]) + '-' + pad(dm[3]);
    }

    // ---- 3. 总幅度（只用于存疑时的说明文案） ----
    var totalDelta = null;
    var totalM = text.match(/每升(?:汽柴油)?(?:价格)?(?:分别)?(上调|下调)([\d.]+)元/);
    if (totalM) {
      var tm = Number(totalM[2]);
      if (isFinite(tm)) totalDelta = totalM[1] === '下调' ? -tm : tm;
    }

    // ---- 4. 判定 ----
    var fuelIds = ['92', '95', '98', '0'];
    // 逐项齐全才算可信：只解析出 1~2 个油品就发布，等于替公告补了缺失的幅度。
    var perFuel = fuelIds.every(function (f) { return typeof deltas[f] === 'number'; });
    // 国内成品油是一次整体调整，各油品方向必须一致
    var hasUp = false;
    var hasDown = false;
    Object.keys(deltas).forEach(function (f) {
      if (deltas[f] > 0) hasUp = true;
      if (deltas[f] < 0) hasDown = true;
    });
    var mixedDirection = hasUp && hasDown;

    var titleMatch = text.match(/(?:国内)?成品油价格按机制(?:上调|下调)/);

    return {
      kind: 'official',
      title: titleMatch ? titleMatch[0] : '国内成品油价格调整',
      executeAt: executeAt,
      delta: totalDelta,
      deltas: deltas,
      perFuel: perFuel,
      ambiguousDirection: ambiguousDirection,
      conflict: conflict,
      mixedDirection: mixedDirection,
      // 机器判定可信：四油品齐全 + 方向明确 + 执行日期明确，且无自相矛盾。
      // 任何一项不满足都判存疑，不对外发布。
      //
      // ⚠️ 这条门槛定得死是有原因的：approved = 对外宣称「这是官方结果」，
      // 猜错的代价是提醒金额全错。所以宁可多进人工核对队列。
      reviewStatus: (perFuel && executeAt && !ambiguousDirection && !conflict && !mixedDirection)
        ? 'approved' : 'pending',
      raw: raw && raw.length > 4000 ? raw.slice(0, 4000) : raw
    };
  },

  /**
   * 解析行情：要求同时拿到品种名、价格和时间，缺一不可。
   */
  genericQuote(raw) {
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!data || typeof data.price !== 'number' || !data.symbol) return null;
    return {
      symbol: data.symbol,
      name: data.name || data.symbol,
      price: data.price,
      changeAmount: Number(data.changeAmount) || 0,
      changePercent: Number(data.changePercent) || 0,
      quoteTime: data.quoteTime || '',
      delayed: !!data.delayed
    };
  }
};

/**
 * 取「每升X元」短语前面那一串连着的油品标号。
 *
 * 「92号汽油、95号汽油、98号汽油每升下调0.10元」里三个标号共用一个幅度，
 * 所以从最后一个标号往前收，只收「中间只隔着分隔符（、和与及以，空白）」的连续一段。
 * 隔着别的字就断开 —— 宁可少收，不能把不相干的油品挂到同一个幅度上。
 *
 * @param {string} text 正文
 * @param {Array} labels 已抓到的标号（带 start/end）
 * @param {number} fromPos 只考虑这个位置之后的标号（= 上一个金额短语的结尾）
 * @param {number} amountStart 金额短语的起始位置
 */
function fuelGroupBefore(text, labels, fromPos, amountStart) {
  var candidates = labels.filter(function (l) {
    return l.start < amountStart && l.start >= fromPos;
  });
  if (!candidates.length) return [];
  var group = [candidates[candidates.length - 1]];
  for (var i = candidates.length - 2; i >= 0; i--) {
    var gap = text.slice(candidates[i].end, group[0].start);
    if (/^[、和与及以,，\s]*$/.test(gap)) group.unshift(candidates[i]);
    else break;
  }
  // 最后一个标号到金额短语之间也只能是分隔符，否则说明它们不是同一件事
  var tail = text.slice(group[group.length - 1].end, amountStart);
  if (!/^[、和与及以,，\s]*$/.test(tail)) return [];
  return group;
}

/**
 * 解析地区页里的下次调价预测（#EA5146 边框的提示 div）。
 *
 * 返回 { date, time, direction, changeTon, literMin, literMax, text }：
 *   direction: 'up' | 'down' | 'flat'
 *   changeTon: 元/吨，带符号；literMin/literMax: 元/升区间，无符号幅度
 *   幅度解析不出时为 null —— 方向与日期是页面明说的，幅度不猜。
 * 整个区块缺失或日期/方向解析不出时返回 null。
 */
function qyjTrend(html, now) {
  var m = html.match(/<div[^>]*style=["'][^"']*#EA5146[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return null;
  // 区块里有 document.writeln 的 script，先剥掉再去标签
  var text = stripTags(m[1].replace(/<script[\s\S]*?<\/script>/gi, ''));

  var dateM = text.match(/下次油价(\d{1,2})月(\d{1,2})日(\d{1,2})时调整/);
  var dirM = text.match(/预计(?:将)?(上调|下调|搁浅|不作调整)/);
  // 只有日期没有方向（或反过来）都不算可发布的预测，不猜
  if (!dateM || !dirM) return null;

  var direction = dirM[1] === '上调' ? 'up' : dirM[1] === '下调' ? 'down' : 'flat';
  var sign = direction === 'down' ? -1 : 1;

  var changeTon = null;
  // 「上调90元/吨」与「上调油价90元/吨」两种写法都要认
  var tonM = text.match(/(?:上调|下调)(?:油价)?(\d+(?:\.\d+)?)元\/吨/);
  if (tonM) changeTon = sign * Number(tonM[1]);

  var literMin = null;
  var literMax = null;
  var literM = text.match(/(\d+(?:\.\d+)?)元\/升[-~～—](\d+(?:\.\d+)?)元\/升/);
  if (literM) {
    literMin = Number(literM[1]);
    literMax = Number(literM[2]);
  }
  if (direction === 'flat') {
    changeTon = 0;
    literMin = 0;
    literMax = 0;
  }

  // 页面只写「X月X日」不写年份。调价周期为 10 个工作日，下一轮窗口
  // 必在两周左右内：解析出的日期比今天早 20 天以上，说明跨年了。
  // 统一按 UTC+8 日历日算（服务器可能跑在 UTC，不能直接用本地时区）。
  var cn = new Date((typeof now === 'number' ? now : Date.now()) + 8 * 3600000);
  var todayTs = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate());
  var month = Number(dateM[1]);
  var day = Number(dateM[2]);
  var dateTs = Date.UTC(cn.getUTCFullYear(), month - 1, day);
  if (dateTs < todayTs - 20 * 86400000) {
    dateTs = Date.UTC(cn.getUTCFullYear() + 1, month - 1, day);
  }

  return {
    date: new Date(dateTs).toISOString().slice(0, 10),
    time: pad(dateM[3]) + ':00',
    direction: direction,
    changeTon: changeTon,
    literMin: literMin,
    literMax: literMax,
    text: text.slice(0, 200)
  };
}

/** 去标签、去空白（含全角空格） */
function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/[\s　]+/g, '');
}

function pad(n) {
  n = String(n);
  return n.length < 2 ? '0' + n : n;
}

/**
 * 正文里的油品叫法 → 内部油品 id
 *
 * ⚠️ 标号必须从文本里明确抓到数字（92号 / 95# / 98号 / 0号）。
 * 泛称「汽油」有 92 / 95 / 98 三个标号，猜不出来 → 返回 null，不填；
 * 「柴油」国内只有 0# 一种标号，能确定。
 *
 * 之前把「汽油」一律映射成 92，结果 98 号汽油的幅度被记到 92# 头上 ——
 * 而且 perFuel 判定照样是「解析成功」，错的幅度就这样被当成可信结果。
 */
function fuelKeyOf(text) {
  var s = String(text || '');
  var num = s.match(/(\d{1,3})[#号]/);
  if (num) {
    return { '92': '92', '95': '95', '98': '98', '0': '0' }[num[1]] || null;
  }
  if (s.indexOf('柴油') !== -1) return '0';
  return null;
}

module.exports = { SOURCES: SOURCES, PARSERS: PARSERS };
