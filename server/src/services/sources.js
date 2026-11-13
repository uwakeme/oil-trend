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

    // 必须连方向一起抓：之前只抓数字，Number() 恒为正，
    // 「下调 0.08 元」会被解析成 +0.08，涨跌方向整个反掉。
    var m = text.match(/每升(?:汽柴油)?(?:价格)?(?:分别)?(上调|下调|调整)([\d.]+)元/);
    if (!m) return null;
    var magnitude = Number(m[2]);
    if (!isFinite(magnitude)) return null;
    var totalDelta = m[1] === '下调' ? -magnitude : magnitude;

    var executeAt = null;
    // 公告写的是「24时起」，不是「24:00」—— 只认 24:00 会把日期整个丢掉，
    // 而没有日期的通知既没法倒计时也没法触发提醒。
    var m2 = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:24时|24:00)/);
    if (m2) {
      executeAt = m2[1] + '-' + pad(m2[2]) + '-' + pad(m2[3]);
    }

    // 各油品幅度本来就不同，正文里通常逐个油品写。
    // 能分别解析就分别解析，解析不出来就整体进人工核对。
    var deltas = {};
    // ⚠️ 油品标号必须从正文里明确抓到数字（92号 / 95# / 98号 / 0号），
    // 不能靠「汽油」这种泛称去猜标号 ——
    // 发改委公告正文写的是「98号汽油每升下调0.10元」，
    // 按泛称匹配会把 98# 的幅度记到 92# 头上（后一段覆盖前一段）。
    // 中间的间隔也不允许出现数字、逗号、顿号，
    // 否则「92号汽油、98号汽油每升下调0.10元」同样会串号。
    var fuelRe = /((?:\d{1,3}[#号])?(?:汽油|柴油))[^。；;，,、0-9]{0,8}?每升(?:价格)?(上调|下调|调整)([\d.]+)元/g;
    var hit;
    while ((hit = fuelRe.exec(text)) !== null) {
      var fuelKey = fuelKeyOf(hit[1]);
      if (!fuelKey) continue;   // 泛称「汽油」猜不出标号，不填
      var value = Number(hit[3]);
      if (!isFinite(value)) continue;
      deltas[fuelKey] = hit[2] === '下调' ? -value : value;
    }
    // 逐项解析出来了才算可信；一个都没解析出来就只剩总幅度，那是猜的
    var perFuel = Object.keys(deltas).length > 0;

    var titleMatch = text.match(/(?:国内)?成品油价格按机制(?:上调|下调)/);

    return {
      kind: 'official',
      title: titleMatch ? titleMatch[0] : '国内成品油价格调整',
      executeAt: executeAt,
      delta: totalDelta,
      deltas: deltas,
      perFuel: perFuel,
      // 机器判定可信：逐项幅度明确 **且** 执行日期明确。
      // 两者缺一都说明正文写法跟预期不符，整条存疑，不对外发布。
      reviewStatus: (perFuel && executeAt) ? 'approved' : 'pending',
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
