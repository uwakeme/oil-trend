/**
 * 采集源配置
 *
 * 来源启用状态：
 *   - xmgcn（油价网）：已启用，**现价与历史的主源**。2026-11-16 实测 31 省
 *     页面结构完全一致，一次请求同时给当前价与最近 30 期历史挂牌价
 *     （2025-09-10 → 2026-11-13）；31 省最新价与线上现价逐值比对差异 0.00。
 *     站点有 HTTPS，历史表行序是降序（解析后必须按日期升序重排）。
 *   - qiyoujiage（汽油价格网）：已启用，改任**预测源 + 兜底 + 交叉校核**。
 *     全网唯一给「下次调价预测」的源，但它没有 HTTPS、没有历史；
 *     2026-11-12 完成真实抓取验证 —— 省级地区页结构一致（北京/陕西/云南抽查），
 *     解析出的挂牌价与 data/reference-prices.js（独立来源）逐值核对一致；
 *     页面 utf-8，无需 Referer/Cookie。站点声明价格仅供参考，展示侧必须保留来源标注。
 *   - xmgcn-timeline（官方调价时间表）：已启用，**只做口径互校**，不对外展示。
 *   - market-quote：仍默认关闭。启用前需单独验证
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
    id: 'xmgcn',
    name: '油价网',
    kind: 'price',
    enabled: true,
    // 降级链顺序：数字小的先试。前一个源成功的省，不再问后面的源。
    priority: 1,
    provides: ['price', 'history'],
    url: 'https://www.xmgcn.com/',
    // 地区页 = urlTemplate 里的 {slug} 换成该省在这个站的路径名（真源在 data/regions.js 的 slugs）
    urlTemplate: 'https://www.xmgcn.com/{slug}/',
    // 允许跳转的主机：跳去别处就拒绝（避免请求被引到不可控的服务器）
    allowedHosts: ['www.xmgcn.com'],
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    parser: 'xmgcnRegion',
    // 价格只在调价日变化：freshHours 内抓过的地区跳过，不每 30 分钟打一遍全站
    freshHours: 6,
    note: '各省历史挂牌价表（最近 30 期）与当前价。HTTPS，一次请求同时给现价与整段历史。'
  },
  {
    id: 'qiyoujiage',
    name: '汽油价格网',
    kind: 'forecast',
    enabled: true,
    // 降级链里排第二：主源某个省抓不到时，它补那一省的现价
    priority: 2,
    provides: ['forecast', 'price'],
    // ⚠️ 这个站**没有** HTTPS：证书是腾讯 CDN 的通用证书，
    // altnames 里没有 qiyoujiage.com，https 握手直接失败（2026-11-13 实测）。
    // 只能走 HTTP —— 所以抓取层必须做交叉校验兜底（见 collector.js 的 saveRegionPrices）。
    url: 'http://www.qiyoujiage.com/',
    urlTemplate: 'http://www.qiyoujiage.com/{slug}.shtml',
    // 允许跳转的主机：站点改版跳到 CDN 域名时还能跟上，
    // 跳去别处就拒绝（避免请求被引到不可控的服务器）。
    allowedHosts: ['www.qiyoujiage.com'],
    headers: {
      // 站点按 UA 做移动版跳转，用桌面浏览器 UA 拿 PC 页（参考 60s / OilPrice 的做法）
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    parser: 'qiyoujiageRegion',
    // 交叉校核抽查这几个省：南（广东）/ 东（山东）/ 西（新疆）。
    // 各省价差各异，异常更容易露出来。只抓 3 个，别每轮打一遍全站 —— 这站会限流。
    verifyRegions: ['440000', '370000', '650000'],
    freshHours: 6,
    note: '下次调价预测（非官方，全网唯一）；现价只作主源失败时的兜底与交叉校核。'
  },
  {
    id: 'xmgcn-timeline',
    name: '油价网·官方调价时间表',
    kind: 'timeline',
    enabled: true,
    provides: ['timeline'],
    url: 'https://www.xmgcn.com/tiaozheng/',
    allowedHosts: ['www.xmgcn.com'],
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    parser: 'xmgcnTimeline',
    note: '全国调价时间表（各省最高零售价元/吨与涨跌）。只做口径互校，不对外展示。'
  },
  {
    id: 'ndrc-notice',
    name: '国家发展改革委价格司',
    kind: 'notice',
    // 2026-11-16 完成只读验证：列表页与详情页均可访问，采集器 UA 不被拦，
    // 正文结构稳定（div.TRS_Editor），条款要求「如需转载，请注明来源」。
    // ⚠️ robots.txt 被站点 WAF 挡（403），抓取约定无法确认 → 只低频抓、
    // 抓到的公告已入库就不再重复抓详情。
    enabled: true,
    // 列表页 → 详情页两步抓取
    url: 'https://www.ndrc.gov.cn/xwdt/xwfb/',
    listUrl: 'https://www.ndrc.gov.cn/xwdt/xwfb/',
    listParser: 'ndrcNoticeList',
    // 只取标题里带这些词的公告，其余是新闻发布会、答记者问，与油价无关
    itemTitleKeywords: ['成品油价格'],
    // 单轮最多抓几篇详情页
    maxItems: 5,
    headers: {},
    parser: 'ndrcNotice',
    note: '正式调价公告：方向 + 执行日期 + 汽/柴油吨价。附件价目表是图片，不解析'
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
   * 解析油价网省份页（https://www.xmgcn.com/{slug}/）。
   *
   * 页面结构（2026-11-16 实测，31 省完全一致）：
   *   当前价区  <div class="price-card n92">
   *                <div class="oil-name">92号汽油</div>
   *                <span class="price-value">8.39</span>
   *                <span class="price-change down"> -0.52 </span>
   *              </div>
   *   历史表    <div class="history-table"><table>
   *                <thead><tr><th>日期</th><th>89号汽油</th><th>92号汽油</th>…</tr></thead>
   *                <tbody><tr><td>2026-11-13</td>
   *                  <td class="price-cell"><div>7.79</div><div class="change-cell change-down">-0.48</div></td>…
   *
   * ⚠️ 三个必须记住的点：
   *   1. 表格行序是**降序**（最新在前），入库前必须按日期升序重排 ——
   *      顺序搞反，「相邻期变化」会全部反号，测出来的涨跌额也跟着反。
   *   2. 列与油品的对应靠**表头**（89/92/95/98/0 号）解析，别按位置硬编码。
   *   3. 89 号汽油在部分省是「-」（内蒙古/吉林/新疆/河南/湖北/辽宁/黑龙江不供 89#），
   *      本项目不做 89#，直接跳过。
   *
   * 密集请求时站点会返回**残页**（表格 tbody 为空），所以行数不足直接返回 null，
   * 让采集器重试 —— 半张表比没有表更危险。
   *
   * @param {string} raw 页面 HTML
   * @returns {{prices:object, changes:object, history:Array}|null}
   *   history 按日期**升序**，每项 { date, prices:{92,95,98,0}, changes:{} }
   */
  xmgcnRegion(raw) {
    var html = String(raw || '');

    // ---- 1. 当前价 ----
    var prices = {};
    var changes = {};
    var parts = html.split(/<div class="price-card n/);
    for (var i = 1; i < parts.length; i++) {
      var seg = parts[i];
      var idM = seg.match(/^(\d+)"/);
      if (!idM) continue;
      var fuelId = { '92': '92', '95': '95', '98': '98', '0': '0' }[idM[1]];
      if (!fuelId) continue;
      var pm = seg.match(/<span class="price-value">\s*([0-9]+(?:\.[0-9]+)?)\s*<\/span>/);
      if (!pm) continue;
      var price = Number(pm[1]);
      // 挂牌价的合理区间：超出说明页面结构变了或解析错位，整体转人工
      if (!isFinite(price) || price < 3 || price > 20) return null;
      prices[fuelId] = price;
      var cm = seg.match(/<span class="price-change[^"]*">\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*<\/span>/);
      if (cm) changes[fuelId] = Number(cm[1]);
    }
    if (!prices['92'] || !prices['95'] || !prices['98'] || !prices['0']) return null;

    // ---- 2. 历史表 ----
    var tb = html.indexOf('<div class="history-table">');
    if (tb < 0) return null;
    var end = html.indexOf('</table>', tb);
    if (end < 0) return null;
    var tableHtml = html.slice(tb, end);
    var trs = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (trs.length < 2) return null;

    // 表头驱动列映射：第 0 列是日期，其余按表头的标号对应油品
    var headerIdx = -1;
    for (var ti = 0; ti < trs.length; ti++) {
      if (/<th[\s>]/i.test(trs[ti])) { headerIdx = ti; break; }
    }
    if (headerIdx < 0) return null;
    var headerCells = (trs[headerIdx].match(/<th[^>]*>[\s\S]*?<\/th>/gi) || []).map(stripTags);
    var colFuel = [];
    for (var h = 0; h < headerCells.length; h++) {
      var num = headerCells[h].match(/(\d{1,3})号/);
      colFuel[h] = num ? ({ '92': '92', '95': '95', '98': '98', '0': '0' }[num[1]] || null) : null;
    }

    var history = [];
    for (var r = headerIdx + 1; r < trs.length; r++) {
      var cells = trs[r].match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
      if (cells.length < 2) continue;
      var dm = cells[0].match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!dm) continue;
      var row = { date: dm[1] + '-' + dm[2] + '-' + dm[3], prices: {}, changes: {} };
      for (var c = 1; c < cells.length && c < colFuel.length; c++) {
        var fid = colFuel[c];
        if (!fid) continue;
        // ⚠️ 价格必须从**原始 HTML** 里取，不能先把标签和空白全去掉再取：
        //   去掉空白后「价格 10」+「涨跌 0」会粘成「100」——
        //   内蒙古 98# 在 2026-09-25 / 2026-10-16 正好是整数 10，
        //   粘成 100 之后那两期的涨跌会变成 +90 / -89.68，整条序列全乱，
        //   还会把跨省一致性闸门误报成「偏离 89.98」。
        var pv = cells[c].match(/<div>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/div>/);
        if (!pv) continue;
        row.prices[fid] = Number(pv[1]);
        // 涨跌的正负号写在 **class** 上（change-up / change-down / change-unchanged），
        // 文本里的数字没有符号（「0」就是持平），所以符号要从 class 取。
        var cv = cells[c].match(/change-(up|down|unchanged)/);
        if (cv) {
          var magM = cells[c].match(/change-(?:up|down|unchanged)[^>]*>\s*([+-]?[0-9]+(?:\.[0-9]+)?)?/);
          var mag = magM && magM[1] !== undefined ? Math.abs(Number(magM[1])) : 0;
          row.changes[fid] = cv[1] === 'down' ? -mag : (cv[1] === 'up' ? mag : 0);
        }
      }
      // 四个油品缺一个就不是完整的一期，跳过（残缺的行不能拿去算涨跌）
      if (!row.prices['92'] || !row.prices['95'] || !row.prices['98'] || !row.prices['0']) continue;
      history.push(row);
    }
    // 残页：站点在密集请求下会返回空 tbody 或半张表
    if (history.length < 20) return null;

    // 页面行序是降序（最新在前），必须按日期升序重排
    history.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

    return { prices: prices, changes: changes, history: history };
  },

  /**
   * 解析油价网的官方调价时间表（https://www.xmgcn.com/tiaozheng/）。
   *
   * 表格结构（2026-11-16 实测，51 行）：
   *   排名 | 调整日期 | 汽油价格(元/吨) | 汽油涨跌 | 柴油价格(元/吨) | 柴油涨跌
   *   48 | 2024-06-28 | 9220 | +210 (+2.28%) | 8175 | +200 (+2.45%)
   *
   * 这是**官方公布的各省最高零售价（元/吨）**，与「每升挂牌价」是不同口径：
   * 元/升 = 元/吨 ÷ 1000 × 密度（89# 汽油 0.725、0# 柴油 0.835 kg/L）。
   * 它只用来做**口径互校**（见 collector.js 的 timelineCrossCheck），
   * 不作为对外展示的每升幅度。
   *
   * @param {string} raw 页面 HTML
   * @returns {{items:Array}|null} items 按日期升序
   */
  xmgcnTimeline(raw) {
    var html = String(raw || '');
    var trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    var items = [];
    for (var i = 0; i < trs.length; i++) {
      var cells = (trs[i].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
      if (cells.length < 6) continue;
      var dm = cells[1].match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!dm) continue;
      var gTon = cells[2].match(/([0-9]+(?:\.[0-9]+)?)/);
      var gDelta = cells[3].match(/([+-][0-9]+)/);
      var dTon = cells[4].match(/([0-9]+(?:\.[0-9]+)?)/);
      var dDelta = cells[5].match(/([+-][0-9]+)/);
      items.push({
        date: dm[1] + '-' + dm[2] + '-' + dm[3],
        gasolineTon: gTon ? Number(gTon[1]) : null,
        gasolineDelta: gDelta ? Number(gDelta[1]) : null,
        dieselTon: dTon ? Number(dTon[1]) : null,
        dieselDelta: dDelta ? Number(dDelta[1]) : null
      });
    }
    if (items.length < 10) return null;
    items.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    return { items: items };
  },

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
   * 解析发改委调价公告。
   *
   * 公告的真实形态（2026-11-16 实测四篇，列表页 → 详情页两步抓取）：
   *   标题    「2026年11月12日国内成品油价格调整」
   *   正文    自11月12日24时起，国内汽、柴油（标准品）价格每吨分别下调645元、625元。
   *   调控类  自10月29日24时起，…每吨分别应上调440元、420元，…调控后实际上调345元、335元。
   *   搁浅类  本次汽、柴油价格不作调整。
   *   附表    是 JPG 图片（各省最高零售价），不是 HTML 表格，不解析。
   *
   * ⚠️ 公告**只给吨价、只分汽/柴油两类**，没有「四油品每升幅度」。
   * 每升四油品幅度由展示层拿各地挂牌价的前后快照差值测算
   * （server/src/services/measure.js），界面必须标注「据挂牌价测算」，
   * 不能写成官方公布值。
   *
   * 方向只认「上调/下调/不作调整」。「应上调」是机制算出的**理论值**，
   * 不是实际执行值 —— 调控类公告同段里「应上调440元」与「实际上调345元」并存，
   * 只能取「实际上调」。
   *
   * ⚠️ reviewStatus 是**机器判定**的可信度标记，不是人工审核结论：
   *   approved —— 方向明确 + 执行日期明确 + （上调/下调时）汽/柴油吨价齐全；
   *   pending  —— 正文写法与预期不符，存疑不发布，等人工核对。
   */
  ndrcNotice(raw, meta) {
    var html = String(raw || '');
    var metaInfo = meta || {};

    // 正文：优先取 article_con 容器（到右侧排行榜 div 之前），
    // 拿不到再退回 div.TRS_Editor。script 里的字符串可能含 </div>，先剥掉。
    var bodyHtml = '';
    var conM = html.match(/<div class="article_con[^"]*"[^>]*>([\s\S]*?)<div class="article_r"/);
    if (conM) bodyHtml = conM[1];
    else {
      var trsM = html.match(/<div class=TRS_Editor>([\s\S]*?)/);
      if (trsM) bodyHtml = trsM[1];
    }
    bodyHtml = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
    var text = stripTags(bodyHtml);

    // ---- 1. 标题与公告日期 ----
    var title = metaInfo.title || '';
    if (!title) {
      var atM = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]*)"/i);
      if (atM) title = atM[1];
    }
    if (!title) {
      var h2M = html.match(/<h2[^>]*class="article_title"[^>]*>([\s\S]*?)<\/h2>/i);
      if (h2M) title = stripTags(h2M[1]);
    }
    title = String(title).replace(/\s+/g, ' ').trim();

    var announcedAt = '';
    var pubM = html.match(/<meta\s+name="PubDate"\s+content="([\d-]+)/i);
    if (pubM) announcedAt = pubM[1];
    if (!announcedAt) {
      var tm = html.match(/发布时间：([\d/]+)/);
      if (tm) announcedAt = tm[1].replace(/\//g, '-');
    }
    // 标题里的日期是执行日（公告在执行当天发布），比 PubDate 更可靠
    var titleDateM = title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    var titleYear = titleDateM ? Number(titleDateM[1]) : 0;
    if (!announcedAt && titleDateM) {
      announcedAt = titleDateM[1] + '-' + pad(titleDateM[2]) + '-' + pad(titleDateM[3]);
    }

    // ---- 2. 执行日期 ----
    // 只认「自X月X日24时起」这种带生效语义的写法。
    // 被「上次/上轮/此前」修饰的日期是上一轮的，不能当本轮生效日。
    var executeAt = '';
    var execM = text.match(/(?:自)?(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:24时|24:00)/);
    if (execM) {
      var before = text.slice(Math.max(0, execM.index - 16), execM.index);
      if (!/上次|上轮|此前|前次|上一轮/.test(before)) {
        var y = execM[1]
          ? Number(execM[1])
          : (titleYear || (announcedAt ? Number(announcedAt.slice(0, 4)) : 0));
        if (y) {
          var d = new Date(Date.UTC(y, Number(execM[2]) - 1, Number(execM[3])));
          // 跨年：12 月发布、次年 1 月执行时，组合出来的日期会早一年
          if (announcedAt) {
            var pubTs = Date.parse(announcedAt + 'T00:00:00Z');
            if (isFinite(pubTs) && d.getTime() < pubTs - 60 * 86400000) {
              d = new Date(Date.UTC(y + 1, Number(execM[2]) - 1, Number(execM[3])));
            }
          }
          executeAt = d.toISOString().slice(0, 10);
        }
      }
    }
    // 正文没写「24时起」（搁浅公告写「本次…不作调整」）→ 执行日取标题日期
    if (!executeAt && titleDateM) {
      executeAt = titleDateM[1] + '-' + pad(titleDateM[2]) + '-' + pad(titleDateM[3]);
    }

    // ---- 3. 方向与吨价幅度 ----
    var direction = '';
    var tonChanges = {};
    var theoryOnly = false;

    var flatM = text.match(/汽、?柴油(?:价格)?不作调整|汽、?柴油价格不予调整|汽、?柴油价格暂不调整/);
    if (flatM) {
      direction = 'flat';
    } else {
      // 实际值优先：调控类公告同段里「应上调X」与「实际上调Y」并存，
      // 只能取「实际上调」—— 「应上调」是机制算出的理论值，不是实际执行值。
      var actM = text.match(/实际(上调|下调)([\d.]+)元、([\d.]+)元/);
      var directM = actM ? null : text.match(/每吨分别(上调|下调)([\d.]+)元、([\d.]+)元/);
      var useM = actM || directM;
      if (useM) {
        direction = useM[1] === '下调' ? 'down' : 'up';
        var sign = useM[1] === '下调' ? -1 : 1;
        tonChanges.gasoline = sign * Number(useM[2]);
        tonChanges.diesel = sign * Number(useM[3]);
      } else {
        // 只有「应上调/应下调」：方向明确，但幅度是理论值，不是实际执行值
        var theoryM = text.match(/每吨分别应(上调|下调)/);
        if (theoryM) {
          direction = theoryM[1] === '下调' ? 'down' : 'up';
          theoryOnly = true;
        }
      }
    }

    // ---- 4. 判定 ----
    // 公告层面可信 = 方向明确 + 执行日期明确 + 上调/下调时汽/柴油吨价齐全。
    // 每升四油品幅度公告不给 —— 那部分由展示层测算，不在这里猜。
    var tonOk = direction === 'flat'
      ? true
      : (typeof tonChanges.gasoline === 'number' && typeof tonChanges.diesel === 'number');
    var reviewStatus = (direction && executeAt && tonOk && !theoryOnly) ? 'approved' : 'pending';

    return {
      kind: 'official',
      title: title || '国内成品油价格调整',
      announcedAt: announcedAt,
      executeAt: executeAt,
      direction: direction,
      tonChanges: tonChanges,
      // 每升四油品幅度：公告不给，留在空对象里，由展示层测算后另给
      deltas: {},
      perFuel: false,
      theoryOnly: theoryOnly,
      reviewStatus: reviewStatus,
      raw: html.length > 4000 ? html.slice(0, 4000) : html
    };
  },

  /**
   * 解析发改委「新闻发布」列表页，取出公告的标题与详情页链接。
   *
   * 页面结构（2026-11-16 实测）：
   *   <div class="list"><ul class="u-list">
   *     <li><a href="./202611/t20261112_1408795.html" target="_blank"
   *          title="2026年11月12日国内成品油价格调整">…</a><span>2026/11/12</span></li>
   *   </ul></div>
   *
   * ⚠️ href 是**相对**链接（./202611/…），必须用 new URL(href, base) 拼接 ——
   * 手工拼字符串会变成 www.ndrc.gov.cn. 这种带尾点的域名，证书 altnames 不匹配。
   */
  ndrcNoticeList(raw, baseUrl) {
    var html = String(raw || '');
    var base = baseUrl || 'https://www.ndrc.gov.cn/xwdt/xwfb/';
    var items = [];
    var liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
    var lm;
    while ((lm = liRe.exec(html)) !== null) {
      var inner = lm[1];
      var aM = inner.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!aM) continue;
      var href = aM[1];
      // 有些站点会在链接后面挂查询串，别把这种当成非文章页
      if (!/\.html?(\?|$)/i.test(href)) continue;
      var titleAttr = (aM[0].match(/title="([^"]*)"/) || [])[1] || '';
      var title = String(titleAttr || stripTags(aM[2])).replace(/\s+/g, ' ').trim();
      if (!title) continue;
      var spanM = inner.match(/<span>([\s\S]*?)<\/span>/);
      var publishedAt = '';
      if (spanM) {
        var parts = stripTags(spanM[1]).split('/');
        if (parts.length === 3) {
          publishedAt = parts[0] + '-' + pad(parts[1]) + '-' + pad(parts[2]);
        }
      }
      var url = '';
      try {
        url = new URL(href, base).href;
      } catch (e) {
        continue;
      }
      items.push({ title: title, url: url, publishedAt: publishedAt });
    }
    return { items: items };
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

  // ⚠️ 站点有两种写法（2026-11-16 实测）：
  //   轮次前（预测）：「下次油价11月12日24时调整 … 目前预计上调油价90元/吨(0.07元/升-0.08元/升)」
  //   轮次后（结果）：「油价11月12日24时调整 … 下跌0.51元/升-0.63元/升」
  // 「下次」「预计」这两个词**只在预测写法里出现**，是区分二者的唯一依据。
  // 轮次一过，站点就改成公布结果；那时候还把它当「下次窗口」，
  // 页面就会显示一个已经过去的预测。
  var dateM = text.match(/(?:下次)?油价(\d{1,2})月(\d{1,2})日(\d{1,2})时调整/);
  var forecastM = text.match(/预计(?:将)?(上调|下调|搁浅|不作调整)/);
  var resultM = text.match(/(上涨|下跌|搁浅|不作调整)/);
  // 只有日期没有方向（或反过来）都不算可发布的预测，不猜
  if (!dateM || (!forecastM && !resultM)) return null;

  var isForecast = !!forecastM;
  var dirWord = forecastM ? forecastM[1] : resultM[1];
  var direction = (dirWord === '上调' || dirWord === '上涨') ? 'up'
    : ((dirWord === '下调' || dirWord === '下跌') ? 'down' : 'flat');
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
    // true = 来源在预测下一轮；false = 来源公布的是某一轮的结果
    isForecast: isForecast,
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
