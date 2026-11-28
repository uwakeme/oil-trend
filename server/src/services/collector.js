/**
 * 定时采集
 *
 * 逻辑与早期云函数实现一致（云函数已下线，见 git 历史）。
 *
 * 关键约束不变：
 *   1. 解析失败不猜测，进 needsReview 人工核对队列；
 *   2. 通知按 dedupKey 去重，重复抓取不会重复入库；
 *   3. 每次运行都写 collector_runs，前端据此展示「同步状态」。
 *
 * ⚠️ 2026-11-16 起改成**多源协作**（见 server/docs/data-source-design.md）：
 *
 *   价格源降级链（按 provides 含 price 排 priority）
 *     xmgcn（油价网，HTTPS）—— 现价 + 近 30 期历史，主源
 *       ↓ 某省抓不到才轮到
 *     qiyoujiage（汽油价格网，HTTP）—— 兜底现价
 *
 *   预测源 qiyoujiage —— 全网唯一给「下次调价预测」的源；
 *                        抓抽样省份时顺带跟主源现价交叉校核。
 *
 *   口径互校 xmgcn-timeline —— 官方公布的每吨涨跌换算成每升，
 *                               跟各省实测的跨省中位数比一比，两套独立数据互证。
 *
 *   公告源 ndrc-notice —— 正式调价公告。
 *
 * 地区价格源：价格只在调价日变化，默认 6 小时新鲜期，
 * 31 省 3 并发抓取；run({ regionCode, force }) 可单地区强制采集。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const sources = require('./sources');
const httpClient = require('./http-client');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  // 统一按 UTC+8 日历日算：服务器可能跑在 UTC，直接用本地时区会在早上 8 点前差一天
  var d = new Date(Date.now() + 8 * 3600000);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/** 中位数。跨省统计要用它 —— 均值会被个别离群省拉偏，中位数不会。 */
function median(list) {
  if (!list || !list.length) return 0;
  var s = list.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------------- 抓取 ---------------- */

/** 等一会儿（抓多个页面时对来源站点友好一点） */
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 抓一个来源，把失败原因归一成固定的 reason 码。
 * 网络层交给 http-client，这里只做「响应 → 业务语义」的翻译。
 */
function fetchSource(source) {
  if (!source.url) {
    return Promise.resolve({ ok: false, reason: 'NO_URL', message: '来源未配置地址' });
  }
  return httpClient.get(source.url, {
    headers: Object.assign({ 'User-Agent': 'oil-trend-collector/1.0' }, source.headers || {}),
    timeout: 15000,
    // 响应编码（新浪行情接口是 GB18030，品种名是中文）
    charset: source.charset || '',
    // 重定向只允许跳到白名单里的主机
    allowedHosts: source.allowedHosts || [],
    // 熔断按来源记：这个来源连续被拒到阈值，冷却期内一个请求都不再发
    scope: source.id || ''
  }).then(function (res) {
    // ⚠️ 站点可能用「HTTP 200 + 错误页」拒绝访问（2026-11-24 实测 xmgcn 如此）。
    //    状态码是 200，不看正文就会当成「抓取成功」，然后报「解析不出字段」——
    //    排查方向会被引到解析器上，而真正的原因是**站点在拒绝我们**。
    if (res.blocked) {
      return {
        ok: false,
        reason: 'SOURCE_BLOCKED',
        message: '来源返回错误页（' + res.blocked + '），站点在拒绝访问，不是页面结构变了'
      };
    }
    if (res.statusCode !== 200) {
      return { ok: false, reason: 'HTTP_' + res.statusCode, message: '接口返回异常状态码' };
    }
    return { ok: true, body: res.body };
  }).catch(function (err) {
    var msg = (err && err.message) || String(err);
    var reason = 'FETCH_ERROR';
    var message = msg;
    if (msg === 'TIMEOUT' || msg === 'TOTAL_TIMEOUT') {
      reason = 'FETCH_TIMEOUT';
    } else if (msg === 'SOURCE_BLOCKED_COOLDOWN') {
      reason = 'SOURCE_BLOCKED_COOLDOWN';
      message = '来源处于拒绝冷却期，本轮不再请求它（上一轮连续被拒）';
    } else if (msg === 'RESPONSE_TOO_LARGE') {
      reason = 'RESPONSE_TOO_LARGE';
    } else if (msg === 'URL_INVALID') {
      reason = 'URL_INVALID';
    } else if (msg === 'TOO_MANY_REDIRECTS') {
      reason = 'TOO_MANY_REDIRECTS';
    } else if (msg === 'REDIRECT_BLOCKED') {
      reason = 'REDIRECT_BLOCKED';
    } else if (msg === 'PROTOCOL_UNSUPPORTED') {
      reason = 'PROTOCOL_UNSUPPORTED';
    }
    return { ok: false, reason: reason, message: message };
  });
}

/**
 * 一条采集结果该进哪个桶。
 *
 * ⚠️ 内部源（只做口径互校之类）的失败进 advisory 桶，**不进 needsReview**：
 *    它的数据根本不进界面，它挂了用户看到的价还是对的。
 *    以前 xmgcn 的调价时间表被站点拒绝，每轮都往待核对队列塞一条，
 *    于是调价页长期显示「等待人工核对（1 条）」，而价格与公告全都正常。
 *
 * @param {object} result 采集结果
 * @returns {'needsReview'|'advisory'|null} null = 没问题
 */
function resultBucket(result) {
  if (!result) return null;
  if (result.status === 'degraded') return 'advisory';
  if (result.status !== 'needsReview' && result.status !== 'failed') return null;
  return result.internal === true ? 'advisory' : 'needsReview';
}

/**
 * 这个来源的数据会不会展示给用户。
 *
 * ⚠️ 内部源（口径互校之类）失败**不能**把用户看到的「等待人工核对」点亮：
 * 它的数据根本不进界面，它挂了用户看到的价还是对的。
 * 以前 xmgcn 的调价时间表被站点拒绝，每轮都往待核对队列塞一条，
 * 于是调价页长期显示「等待人工核对（1 条）」，而价格与公告全都正常。
 *
 * 判定顺序：显式 internal 标记 → provides 里有没有用户侧数据 → kind。
 */
var USER_FACING_PROVIDES = ['price', 'history', 'notice', 'forecast', 'window', 'market'];

function isUserFacingSource(source) {
  if (!source) return false;
  if (source.internal === true) return false;
  var provides = source.provides || [];
  if (provides.length) {
    return provides.some(function (p) { return USER_FACING_PROVIDES.indexOf(p) >= 0; });
  }
  // 没写 provides 的源按 kind 判：价格/公告/预测/行情都是用户侧数据
  return ['price', 'notice', 'forecast', 'market'].indexOf(source.kind) >= 0;
}

/**
 * 从已入库的官方公告里取出「每轮调价的官方吨价」，供口径互校使用。
 *
 * ⚠️ 日期口径：公告写「自11月12日24时起」→ executeAt = 11-12，
 *    而新挂牌价从**次日** 00:00 才开始挂（历史表的生效日是 11-13）。
 *    互校要跟历史表的日期对齐，所以这里 +1 天。
 *
 * 为什么用公告而不是第三方时间表：公告是权威一手来源、我们已经在采集了
 * （零额外请求），而且不会因为某个站点关页面就整个失效 ——
 * 2026-11-24 xmgcn 的调价时间表页就变成了「HTTP 200 + nginx 403 错误页」。
 *
 * @param {Array} notices 已入库的公告（approved）
 * @returns {Array} [{ date, gasolineDelta, dieselDelta }]，按日期升序
 */
function tonRoundsFromNotices(notices) {
  var out = [];
  (notices || []).forEach(function (n) {
    var exec = String(n.executeAt || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exec)) return;
    var ton = n.tonChanges || {};
    // 搁浅轮次没有吨价；没有吨价就不参与互校（不猜）
    if (typeof ton.gasoline !== 'number' || !ton.gasoline) return;
    out.push({
      date: shiftDate(exec, 1),
      gasolineDelta: ton.gasoline,
      dieselDelta: typeof ton.diesel === 'number' ? ton.diesel : null
    });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return out;
}

/** 日期平移（天）。解析不出来返回 null。 */
function shiftDate(dateStr, days) {
  var t = Date.parse(dateStr + 'T00:00:00Z');
  if (!isFinite(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/* ---------------- 地区路径名 ---------------- */

/**
 * 某个来源站点的地区页路径名。
 *
 * ⚠️ 各站点的 slug **不一样**，按拼音猜必错：
 *   陕西   qiyoujiage=shanxi-3   xmgcn=shanxi2
 *   内蒙古 qiyoujiage=neimenggu  xmgcn=namenggu
 *   西藏   qiyoujiage=xizang     xmgcn=xicang
 * 真源在 data/regions.js 的 slugs。
 */
function regionSlug(source, region) {
  var slugs = region.slugs || {};
  return slugs[source.id] || '';
}

/** 拼出地区页地址：urlTemplate 里的 {slug} 换成该省在这个站的路径名 */
function regionUrl(source, region) {
  var tpl = source.urlTemplate || (source.url + '{slug}');
  return tpl.replace('{slug}', regionSlug(source, region));
}

/* ---------------- 入库 ---------------- */

/**
 * 通知摘要：说清楚这条公告给了什么、还缺什么。
 *
 * 对外可见的只有 approved，文案里不能出现「待复核」这种自相矛盾的说法。
 *
 * ⚠️ 发改委公告只给吨价、只分汽/柴油两类，不给四油品每升幅度 ——
 * 所以摘要里写「官方公告：上调，汽油 345 元/吨、柴油 335 元/吨」，
 * 绝不写成「每升下调 0.13 元」这种官方没说过的话。
 */
function noticeSummary(parsed) {
  var direction = parsed.direction || '';
  var ton = parsed.tonChanges || {};
  var dirText = direction === 'up' ? '上调' : direction === 'down' ? '下调' : direction === 'flat' ? '不作调整' : '';
  if (parsed.reviewStatus === 'approved') {
    if (direction === 'flat') {
      return '官方公告：本轮汽、柴油价格不作调整。';
    }
    return '官方公告：' + dirText +
      '，汽油 ' + Math.abs(ton.gasoline) + ' 元/吨、柴油 ' + Math.abs(ton.diesel) + ' 元/吨。';
  }
  if (parsed.theoryOnly) {
    return '来源公告只给出机制理论值（应' + (direction === 'down' ? '下调' : '上调') +
      '），实际执行幅度待公布，待人工核对。';
  }
  if (!direction) {
    return '来源公告未能解析出调整方向，待人工核对。';
  }
  if (!parsed.executeAt) {
    return '来源公告未解析出执行日期，待人工核对后发布。';
  }
  return '来源公告未能解析出完整的汽、柴油吨价幅度，待人工核对。';
}
/**
 * 采集到一条可信的正式公告时，同步补写调价节点。
 *
 * ⚠️ oil_adjust_events 这张表以前只有测试夹具在写，生产库一直是空的，
 * 走势页的调价节点恒不显示（count 恒 0）。
 * 现在节点主要由历史实测推导（见 deriveAdjustEvents），这里保留公告口径的补充。
 */
async function saveAdjustEvent(source, parsed) {
  if (!parsed.executeAt) return null;
  var deltas = parsed.deltas || {};
  if (!Object.keys(deltas).length) return null;
  return dao.events.upsertMany([{
    dedupKey: shared.dedupKey(source.id, parsed.title, parsed.executeAt),
    date: String(parsed.executeAt).slice(0, 10),
    title: parsed.title,
    deltas: deltas,
    source: source.id
  }]);
}

/**
 * 通知入库（去重：同一来源 + 执行日期 + 标题 只保留一条）。
 *
 * ⚠️ review_status 现在是**机器判定**的可信度标记，不是人工审核结论：
 *   approved —— 逐项幅度明确且执行日期明确，可对外发布；
 *   pending  —— 正文写法与预期不符（只解析出总幅度 / 没抓到执行日期），
 *               存疑不发布，等人工核对。
 *
 * ⚠️ 已经存过的「存疑」通知，遇到更可信的解析结果要**覆盖更新**：
 * 否则第一次解析没抓出标号，通知就永远停在存疑状态 ——
 * 解析器修好了重跑也进不来（去重键一样）。
 */
function saveNotice(source, parsed) {
  var key = shared.dedupKey(source.id, parsed.title, parsed.executeAt);
  var doc = {
    kind: parsed.kind,
    title: parsed.title,
    publishedAt: nowIso(),
    // 公告发布日（发改委公告在执行当天发布）
    announcedAt: parsed.announcedAt || '',
    executeAt: parsed.executeAt || '',
    // 调价方向 up/down/flat
    direction: parsed.direction || '',
    // 官方公布的吨价幅度（汽/柴油，元/吨）
    tonChanges: parsed.tonChanges || {},
    // 每升四油品幅度：公告不给，留空。
    // 展示层另给「据挂牌价测算」的值 —— 测算值不能写进官方字段里。
    changes: parsed.deltas || {},
    reviewStatus: parsed.reviewStatus || 'pending',
    summary: noticeSummary(parsed),
    prices: {},
    source: { sourceId: source.id, name: source.name, url: parsed.url || source.url, publishedAt: nowIso() },
    raw: parsed.raw || ''
  };

  return dao.notices.findByDedupKey(key).then(function (exist) {
    if (!exist) {
      // ⚠️ 去重键里带执行日期：解析器修好、日期补上之后键就变了，
      // 「存疑 → 可信」的覆盖更新根本不触发（键不一样），
      // 旧的那条 pending 会永远留在库里。所以按 (来源, 标题) 再回退查一次。
      return dao.notices.findPendingBySourceTitle(source.id, parsed.title).then(function (pendingRow) {
        // ⚠️ 存疑的通知必须**原地覆盖**，不能每次都插一条新的。
        // 以前只在「新的可信、旧的存疑」时覆盖，存疑→仍存疑会插重复行 ——
        // 公告源启用后每 30 分钟重跑一次，重复行会按天堆积。
        if (pendingRow) {
          return dao.notices.update(
            pendingRow.id,
            Object.assign({}, doc, { publishedAt: pendingRow.publishedAt, dedupKey: key })
          ).then(function () {
            var upgraded = pendingRow.reviewStatus !== 'approved' && doc.reviewStatus === 'approved';
            var follow = doc.reviewStatus === 'approved' ? saveAdjustEvent(source, parsed) : Promise.resolve(null);
            return follow.then(function () {
              return { deduped: false, upgraded: upgraded, id: pendingRow.id, reviewStatus: doc.reviewStatus, summary: doc.summary };
            });
          });
        }
        return dao.notices.insert(Object.assign({ dedupKey: key }, doc)).then(function (inserted) {
          // 可信的公告顺手补一条调价节点，走势页才有调价节点可显示
          var follow = doc.reviewStatus === 'approved'
            ? saveAdjustEvent(source, parsed)
            : Promise.resolve(null);
          return follow.then(function () {
            return { deduped: false, id: inserted.id, reviewStatus: doc.reviewStatus, summary: doc.summary };
          });
        });
      });
    }
    // 存疑的遇到可信的 → 用更可信的结果覆盖
    if (exist.reviewStatus !== 'approved' && doc.reviewStatus === 'approved') {
      return dao.notices.update(exist.id, Object.assign({}, doc, { publishedAt: exist.publishedAt }))
        .then(function () {
          return saveAdjustEvent(source, parsed).then(function () {
            return { deduped: false, upgraded: true, id: exist.id, reviewStatus: doc.reviewStatus, summary: doc.summary };
          });
        });
    }
    return { deduped: true, id: exist.id, reviewStatus: doc.reviewStatus, summary: doc.summary };
  });
}

function saveMarket(source, parsed) {
  return dao.markets.upsert({
    symbol: parsed.symbol,
    name: parsed.name,
    price: parsed.price,
    changeAmount: parsed.changeAmount,
    changePercent: parsed.changePercent,
    open: parsed.open || parsed.price,
    prevClose: parsed.prevClose || parsed.price,
    high: parsed.high || parsed.price,
    low: parsed.low || parsed.price,
    quoteTime: parsed.quoteTime,
    delayed: !!parsed.delayed,
    series: parsed.series || [],
    source: source.id
  });
}

/**
 * 合并行情曲线点。
 *
 * 规则：
 *   1. 同一个时间戳只留最后一个（后抓到的更贴近当前状态）；
 *   2. 同一天里既有日线（纯日期）又有分钟线时，**留分钟线** ——
 *      日线那根是「当天收盘」，和当天的分钟线重复，画出来是一根多余的台阶；
 *   3. 按时间升序；只留最近 3000 个点，别让库里无限长。
 *
 * @param {Array} points [{date, value}]
 * @returns {Array} 合并后的点
 */
function mergeMarketPoints(points) {
  var list = [];
  var dayHasIntraday = {};
  (points || []).forEach(function (p) {
    if (!p || typeof p.value !== 'number' || !isFinite(p.value)) return;
    var d = String(p.date || '');
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(d)) return;
    var intraday = d.length > 10;
    if (intraday) dayHasIntraday[d.slice(0, 10)] = true;
    list.push({ date: d, value: p.value, intraday: intraday });
  });
  var byTime = {};
  var order = [];
  list.forEach(function (p) {
    if (!p.intraday && dayHasIntraday[p.date.slice(0, 10)]) return;
    // 用 hasOwnProperty 而不是「值是不是 0」判断首次出现：
    // 值为 0 的点会被当成没出现过，序号里就会重复
    if (!Object.prototype.hasOwnProperty.call(byTime, p.date)) order.push(p.date);
    byTime[p.date] = p.value;
  });
  var merged = order.map(function (k) { return { date: k, value: byTime[k] }; });
  merged.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return merged.length > 3000 ? merged.slice(merged.length - 3000) : merged;
}

/**
 * 国际行情采集（kind = market）。
 *
 * 一个品种要打两类接口：快照（最新价/涨跌/开高低/昨收/报价时刻）
 * 与历史曲线（K 线）。两类接口的失败**分开对待**：
 *   快照失败 → 整条失败（价格是最要紧的，没有就没有）；
 *   曲线失败 → 只缺曲线，价格照旧入库，库里已有的曲线继续用。
 *
 * ⚠️ 曲线是「库里已有的 + 本轮抓到的 + 本次快照」三份合并：
 *    某一次 K 线接口挂掉时，不能把历史抹成空 —— 那样 1周/1月/3月
 *    的曲线会突然全空，看起来像数据被清了。
 *
 * @param {object} source 来源配置
 */
async function collectMarketSource(source) {
  var fetched = await fetchSource({
    id: source.id,
    url: source.quoteUrl,
    headers: source.headers,
    allowedHosts: source.allowedHosts,
    charset: source.charset
  });
  if (!fetched.ok) {
    return { sourceId: source.id, status: 'failed', reason: fetched.reason, message: fetched.message };
  }
  var parsed = null;
  try {
    parsed = sources.PARSERS[source.parser](fetched.body);
  } catch (err) {
    parsed = null;
  }
  if (!parsed) {
    return {
      sourceId: source.id,
      status: 'needsReview',
      reason: 'PARSE_FAILED',
      message: '行情快照抓取成功但解析不出字段，已转人工核对'
    };
  }

  // ---- 历史曲线 ----
  var fetchedPoints = [];
  var seriesFailed = 0;
  var urls = source.seriesUrls || [];
  for (var i = 0; i < urls.length; i++) {
    var one = await fetchSource({
      id: source.id + '-series-' + i,
      url: urls[i],
      headers: source.headers,
      allowedHosts: source.allowedHosts,
      charset: source.charset
    });
    if (!one.ok) {
      seriesFailed++;
      continue;
    }
    var sp = null;
    try {
      sp = sources.PARSERS[source.seriesParser](one.body);
    } catch (err) {
      sp = null;
    }
    if (!sp || !sp.points || !sp.points.length) {
      seriesFailed++;
      continue;
    }
    fetchedPoints = fetchedPoints.concat(sp.points);
  }

  // ---- 合并入库 ----
  var doc = await dao.markets.findBySymbol(source.symbol);
  var existing = (doc && Array.isArray(doc.series)) ? doc.series : [];
  var all = existing.concat(fetchedPoints);
  // 本次快照本身也是一个真实报价点：没有历史接口的来源靠它把曲线攒起来
  if (parsed.quoteTime) all.push({ date: parsed.quoteTime, value: parsed.price });
  var series = mergeMarketPoints(all);

  await saveMarket(source, {
    symbol: source.symbol,
    name: parsed.name || source.symbol,
    price: parsed.price,
    changeAmount: parsed.changeAmount,
    changePercent: parsed.changePercent,
    open: parsed.open,
    prevClose: parsed.prevClose,
    high: parsed.high,
    low: parsed.low,
    quoteTime: parsed.quoteTime,
    // 国际期货行情本来就是延时报价：如实标延时，时长由报价时刻算出来
    delayed: true,
    series: series
  });

  return {
    sourceId: source.id,
    status: seriesFailed ? 'degraded' : 'ok',
    saved: 1,
    points: series.length,
    message: seriesFailed
      ? ('行情快照已更新（' + parsed.price + ' 美元/桶），' + seriesFailed + ' 个曲线接口没取到，曲线沿用库里已有数据')
      : ('行情已更新：' + parsed.price + ' 美元/桶，曲线 ' + series.length + ' 点')
  };
}

/* ---------------- 地区油价采集（kind = price） ---------------- */

/** 读全部当前价，按 地区 → 油品 分组（新鲜度判断与涨跌计算都用它） */
async function loadPricesByRegion() {
  var all = await dao.prices.listAll();
  var map = {};
  all.forEach(function (p) {
    if (!map[p.regionCode]) map[p.regionCode] = {};
    map[p.regionCode][p.fuelId] = p;
  });
  return map;
}

/**
 * 该地区是否在新鲜期内。
 * 只认同来源的真实采集时间 —— seed 演示数据的 updatedAt 不算，
 * 否则演示库会让真实采集永远跳过。
 */
function regionFresh(docs, sourceId, freshHours) {
  if (!docs) return false;
  var latest = 0;
  Object.keys(docs).forEach(function (fuelId) {
    var p = docs[fuelId];
    if (p.source !== sourceId) return;
    var u = p.updatedAt;
    var t = u instanceof Date ? u.getTime() : Date.parse(u || '');
    if (isFinite(t) && t > latest) latest = t;
  });
  return latest > 0 && (Date.now() - latest) < freshHours * 3600000;
}

/** 当前实际供数来源：取该地区最近写入的价格行，不能拿降级链首源代替。 */
function regionSourceOf(docs) {
  var sourceId = '';
  var latest = 0;
  Object.keys(docs || {}).forEach(function (fuelId) {
    var p = docs[fuelId];
    if (!p || !p.source) return;
    var u = p.updatedAt;
    var t = u instanceof Date ? u.getTime() : Date.parse(u || '');
    if (isFinite(t) && t > latest) {
      latest = t;
      sourceId = p.source;
    }
  });
  return sourceId;
}

/**
 * 逐省抓一个价格源。
 *
 * 3 并发 + 每请求间隔 + **解析失败重试 1 次**：
 * 油价网在密集请求下会返回**残页**（历史表 tbody 为空）。
 * 残页必须重试 —— 半张表比没有表危险，残页写进库会画出一条假台阶线。
 *
 * @param {object} source 价格源配置
 * @param {Array} regions 要抓的地区
 * @param {object} cache 本轮请求缓存（同一轮里多个流程共用，避免重复打站点）
 * @returns {Promise<object>} { regionCode: { ok, parsed } | { ok:false, reason, message } }
 */
async function fetchRegionPages(source, regions, cache) {
  var out = {};
  var queue = regions.slice();
  var parser = sources.PARSERS[source.parser];
  async function worker() {
    while (queue.length) {
      var region = queue.shift();
      var key = source.id + '|' + region.code;
      if (cache && Object.prototype.hasOwnProperty.call(cache, key)) {
        out[region.code] = cache[key];
        continue;
      }
      var parsed = null;
      var fail = { reason: 'PARSE_FAILED', message: '页面抓取成功但解析不出四油品价格' };
      for (var attempt = 0; attempt < 2; attempt++) {
        var fetched = await fetchSource({
          id: source.id,
          url: regionUrl(source, region),
          headers: source.headers,
          allowedHosts: source.allowedHosts
        });
        if (!fetched.ok) {
          fail = { reason: fetched.reason, message: fetched.message };
          break;
        }
        try {
          parsed = parser ? parser(fetched.body) : null;
        } catch (err) {
          parsed = null;
        }
        if (parsed) { fail = null; break; }
        fail = { reason: 'PARSE_FAILED', message: '页面抓取成功但解析不出四油品价格（可能是残页）' };
        if (attempt < 1) await delay(1500);
      }
      var result = parsed
        ? { ok: true, parsed: parsed }
        : { ok: false, reason: fail.reason, message: fail.message };
      if (cache) cache[key] = result;
      out[region.code] = result;
      await delay(800);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/**
 * 价格源降级链。
 *
 * 按 priority 顺序逐省尝试：**前一个源成功的省不再问后面的源**；
 * 前一个源失败的省交给下一个源补。两个源都失败的省进人工核对队列，
 * 不写任何猜测值。
 *
 * @param {Array} priceSources provides 含 price 的源，按 priority 升序
 * @param {object} options { regionCode, force, cache }
 */
async function collectPriceChain(priceSources, options) {
  var opts = options || {};
  var cache = opts.cache || {};
  var result = { adopted: {}, rejected: {}, failures: [], degraded: [], fresh: 0, stale: 0 };
  if (!priceSources.length) {
    result.failures.push({ regionCode: '', reason: 'NO_PRICE_SOURCE', message: '没有可用的价格源' });
    return result;
  }
  var primary = priceSources[0];
  var regions = shared.REGIONS.filter(function (r) { return !!regionSlug(primary, r); });
  if (opts.regionCode) {
    regions = regions.filter(function (r) { return r.code === opts.regionCode; });
    if (!regions.length) {
      result.failures.push({
        regionCode: opts.regionCode,
        reason: 'UNKNOWN_REGION',
        message: '地区代码不存在：' + opts.regionCode
      });
      return result;
    }
  }

  var existing = await loadPricesByRegion();
  var freshHours = primary.freshHours || 6;
  var pending = regions.filter(function (r) {
    if (opts.force) return true;
    // 主源被拒后可能一直是备源在供数。按库里实际的来源与新鲜期判断，
    // 否则每轮都会先重抓主源 31 省，再让仍然新鲜的备源价格原样写回去。
    var currentId = regionSourceOf(existing[r.code]);
    var currentSource = priceSources.filter(function (s) { return s.id === currentId; })[0];
    return !currentSource || !regionFresh(
      existing[r.code], currentSource.id, currentSource.freshHours || freshHours
    );
  });
  result.fresh = regions.length - pending.length;
  result.stale = pending.length;

  var lastFailure = {};
  // 每个来源各自记账：主源被站点拒绝、备源接管了多少省份，要看得见
  // （以前只看最终结果，主源全挂、备源全接也看不出来）
  var srcStats = [];
  for (var si = 0; si < priceSources.length && pending.length; si++) {
    var src = priceSources[si];
    var stat = {
      sourceId: src.id,
      name: src.name,
      tried: pending.length,
      ok: 0,
      failed: 0,
      failedRegions: [],
      reasons: {}
    };
    srcStats.push(stat);
    var fetched = await fetchRegionPages(src, pending, cache);
    var stillPending = [];
    pending.forEach(function (region) {
      var r = fetched[region.code];
      if (r && r.ok) {
        stat.ok++;
        result.adopted[region.code] = { source: src, parsed: r.parsed };
        // 主源失败、被备源接管的，要留一条告警（不阻断，但要看得到）
        if (si > 0) {
          result.degraded.push({
            regionCode: region.code,
            regionName: region.name,
            sourceId: src.id,
            message: '主源 ' + primary.name + ' 抓取失败，已由备源 ' + src.name + ' 接管'
          });
        }
      } else {
        stat.failed++;
        stat.failedRegions.push(region.code);
        var reason = r ? r.reason : 'UNKNOWN';
        stat.reasons[reason] = (stat.reasons[reason] || 0) + 1;
        stillPending.push(region);
        lastFailure[region.code] = {
          regionCode: region.code,
          regionName: region.name,
          reason: r ? r.reason : 'UNKNOWN',
          message: r ? r.message : ''
        };
      }
    });
    pending = stillPending;
  }
  result.sourceStats = srcStats;
  pending.forEach(function (region) {
    var f = lastFailure[region.code] || {
      regionCode: region.code,
      regionName: region.name,
      reason: 'REGION_FAILED',
      message: ''
    };
    result.failures.push(f);
  });
  return result;
}

/**
 * 基准价（各省最高零售价快照）。
 *
 * ⚠️ 这份数据只用于交叉校验，不参与运行时。部署时会被拷到服务端
 * （见 CI 的 scp 列表），取不到就跳过校验，不影响采集主流程。
 */
var REFERENCE_PRICES = null;
try {
  REFERENCE_PRICES = require('../../../data/reference-prices.js').REFERENCE_PRICES;
} catch (e) {
  REFERENCE_PRICES = null;
  // ⚠️ 基准价校验会**无声失效**：拿不到基准价时所有偏差检查都跳过，
  // 而表现只是「没告警」—— 看不出是校验没跑还是真的没偏差。
  // 所以这里必须喊一声，别让部署漏了基准价文件还蒙在鼓里。
  console.warn('[collector] 基准价文件未找到（data/reference-prices.js），' +
    '各省基准价偏差校验本次跳过：' + (e && e.message ? e.message : e));
}

/**
 * 与基准价的最大偏差（告警用，不阻断采集）。
 *
 * ⚠️ 阈值要留足正常调价幅度：一次调价才 0.1 元左右，
 * 但基准价是固定快照，几个月后整体就会偏离一截 ——
 * 卡太紧会让每次调价都误报。
 */
var REFERENCE_TOLERANCE = 1.5;

/**
 * 与上一次真实价的最大落差（超出即阻断入库）。
 *
 * ⚠️ 阈值要容得下**一整轮真实调价**：2026-03-24 那轮 98# 全国普涨，
 * 实测最大单期变化 1.13 元/升（92# 0.93、95# 1.01、98# 1.13）。
 * 卡在 1.0 会把这种大轮调价整个挡掉 —— 挡掉的是真数据，不是脏数据。
 * 再往上留 30% 余量，1.5 元以上基本只有两种可能：
 * 页面结构变了导致解析错位，或者链路被动手脚注入了假价。
 */
var JUMP_LIMIT = 1.5;

/**
 * 抓到的价格与基准价对不对得上。
 * 返回 null 表示没问题（或没有基准可比）。
 */
function referenceCheck(region, fuelId, price) {
  if (!REFERENCE_PRICES) return null;
  var base = REFERENCE_PRICES[region.name];
  if (!base) return null;
  var ref = base[fuelId];
  if (typeof ref !== 'number') return null;
  var diff = Math.abs(price - ref);
  if (diff > REFERENCE_TOLERANCE) {
    return { reference: ref, diff: Math.round(diff * 100) / 100 };
  }
  return null;
}

/**
 * 入库一个地区的四油品当前价。
 *
 * 涨跌只跟同来源旧价比：seed 演示价不是真实旧价，差值没有意义。
 * 首次真实采集 changeAmount 记 0、changeAt 留空（不知道上次调价日），
 * 界面据此显示「暂无调价对比」，不假装成持平。
 *
 * ⚠️ 入库前要过两道校验：
 *   1. 与库里上一次真实价比 —— 落差超 JUMP_LIMIT 就不入库，转人工核对；
 *   2. 与各省基准价比 —— 偏差超 1.5 元只记告警，不阻断。
 */
/**
 * 本地区最近一次调价：从**本源自己的历史表**算。
 *
 * 为什么要有这条兜底：价格行里的 changeAt/changeAmount 记的是「最近一次调价」，
 * 但它们只在「同源且价格变了」时才写。换源那一轮同源基线取不到 → 被清空 →
 * 首页四个油品全变成「暂无调价对比」，一直持续到下一次真调价（可能好几周）。
 * 而本源的历史表本来就写着每一期的挂牌价，最近一次变化就是最近一次调价。
 *
 * ⚠️ 用本源历史表而不是各省中位数：首页小卡要的是**本地区**的前后差值，
 * 跟通知卡（各省中位数）不是一个口径，别混。
 *
 * @param {object} parsed 来源解析结果（含 history，日期升序）
 * @param {string} fuelId
 * @returns {object} { amount, date } 或 null
 */
function lastAdjustmentFromHistory(parsed, fuelId) {
  if (!parsed || !parsed.history || parsed.history.length < 2) return null;
  var rows = parsed.history;
  for (var i = rows.length - 1; i > 0; i--) {
    var now = rows[i].prices ? rows[i].prices[fuelId] : undefined;
    var prev = rows[i - 1].prices ? rows[i - 1].prices[fuelId] : undefined;
    if (typeof now !== 'number' || typeof prev !== 'number') continue;
    if (now !== prev) {
      return { amount: shared.round2(now - prev), date: rows[i].date };
    }
  }
  return null;
}

async function saveRegionPrices(source, region, parsed, existing) {
  var today = todayStr();
  var priceDocs = [];
  var historyDocs = [];
  var blocked = [];
  var advisory = [];
  shared.FUELS.forEach(function (fuel) {
    var price = parsed.prices[fuel.id];
    if (price === undefined) return;
    var old = existing[region.code] && existing[region.code][fuel.id];
    var oldReal = old && old.source === source.id ? old : null;

    // 校验一：与库里上一次真实价的落差。
    // 这种价不能进库 —— 继续用旧价，并转人工核对。
    if (oldReal) {
      var jump = Math.abs(price - oldReal.price);
      if (jump > JUMP_LIMIT) {
        blocked.push({
          fuelId: fuel.id,
          price: price,
          previous: oldReal.price,
          diff: Math.round(jump * 100) / 100
        });
        return;
      }
    }
    // 校验二：与各省基准价的偏差（只告警，不阻断）。
    var refIssue = referenceCheck(region, fuel.id, price);
    if (refIssue) {
      advisory.push({
        fuelId: fuel.id,
        price: price,
        reference: refIssue.reference,
        diff: refIssue.diff
      });
    }

    // 本轮是否发生了新的调价：同源且价格变了才算。
    // 换了源不能当成「调价了」—— 两个源的挂牌价口径可能有零点零几的差，
    // 拿它算涨跌等于凭空造一次调价。
    var changed = !!(oldReal && oldReal.price !== price);
    var amount = 0;
    var at = null;
    if (changed) {
      amount = shared.round2(price - oldReal.price);
      at = today;
    } else if (old && old.price === price) {
      // 价格没动 → 上次调价的信息仍然成立。
      // 库里已有基线就原样留着；没有就从本源历史表重建一次。
      if (old.changeAt) {
        amount = old.changeAmount;
        at = old.changeAt;
      } else {
        var lastAdj = lastAdjustmentFromHistory(parsed, fuel.id);
        if (lastAdj) {
          amount = lastAdj.amount;
          at = lastAdj.date;
        }
      }
    }
    priceDocs.push({
      regionCode: region.code,
      regionName: region.name + ' · ' + region.city,
      fuelId: fuel.id,
      fuelName: fuel.name,
      price: price,
      changeAmount: amount,
      changeAt: at,
      source: source.id
    });
    // 历史价记的是「当天生效的挂牌价」，所以每轮都写：
    // 按 (地区, 油品, 日期) 唯一索引幂等覆盖，一天最多一行。
    // 以前只在价格变化时写，30 天没调价就只剩起点的 1 个点，
    // 走势图连一条横线都画不出来 —— 阶梯线的横段本来就该是平的。
    //
    // ⚠️ 这与 saveHistory 写的「来源自己的历史表」是**两回事**：
    //   这里记的是「今天这个价仍然有效」（保证走势线延伸到今天）；
    //   那里记的是「每个调价日的生效价」（给阶梯线拐点）。
    // 两者日期可能重合（调价当天），值相同，幂等 upsert 不会打架。
    historyDocs.push({
      regionCode: region.code,
      fuelId: fuel.id,
      date: today,
      price: price,
      source: source.id
    });
  });
  if (blocked.length) {
    return {
      ok: false,
      reason: 'PRICE_JUMP',
      message: '价格与上次采集相差过大（' + blocked.map(function (b) {
        return b.fuelId + '# ' + b.price + ' vs ' + b.previous;
      }).join('，') + '），已保留旧价并转人工核对',
      details: blocked
    };
  }

  await dao.prices.upsertMany(priceDocs);
  await dao.history.upsertMany(historyDocs);
  return { ok: true, advisory: advisory };
}

/* ---------------- 历史价入库（带五道闸门） ---------------- */

/**
 * 把来源给的历史表摊成 { date: { fuelId: price } }，按日期升序。
 */
function historySeries(parsed) {
  var out = {};
  if (!parsed || !parsed.history || !parsed.history.length) return out;
  parsed.history.forEach(function (row) {
    var byFuel = {};
    Object.keys(row.prices || {}).forEach(function (f) { byFuel[f] = row.prices[f]; });
    out[row.date] = byFuel;
  });
  return out;
}

/** 现价校验被拒绝的地区不能继续污染历史与调价节点。 */
function regionRejected(chain, code) {
  var rejected = (chain && chain.rejected) || {};
  return Array.isArray(rejected) ? rejected.indexOf(code) >= 0 : !!rejected[code];
}

/**
 * 历史序列（各省 → 日期 → 油品价），给入库闸门与调价节点推导用。
 *
 * 优先用**当轮解析出来的来源历史**（油价网的 30 期表，最准）；
 * 解析不出来时（主源被站点拒绝、备源接管 —— 备源没有历史表），
 * 回落到**库里累积的历史**：那是历次采集攒下来的，不依赖某一个源还在。
 *
 * ⚠️ 不回落的后果：主源一被拒，序列就是空的，deriveAdjustEvents 拿不到东西，
 *    调价节点再也不更新（走势页的拐点停在最后一次成功采集那一刻），
 *    而且**没有任何报错** —— 节点数恒为 0，
 *    分不清是「这段时间没调价」还是「根本没数据」。
 *
 * @returns {Promise<{series:object, from:string}>} from = 'source' | 'db'
 */
async function buildSeries(chain) {
  var series = {};
  var adopted = (chain && chain.adopted) || {};
  var codes = Object.keys(adopted).filter(function (code) { return !regionRejected(chain, code); });
  // ⚠️ 这一轮**一个地区都没采到**（全部在新鲜期内跳过、或价格源全挂），
  //    或现价全部被跳变闸门拒绝 → 没有可信的新数据，就不该拿库里的历史
  //    重新推导节点：那是把「这轮没采到」变成「节点变了」。
  if (!codes.length) return { series: series, from: 'none' };
  codes.forEach(function (code) {
    var ser = historySeries(adopted[code].parsed);
    if (Object.keys(ser).length) series[code] = ser;
  });
  if (Object.keys(series).length) return { series: series, from: 'source' };

  // 主源被站点拒绝、备源接管（备源没有历史表）→ 回落用库里累积的历史
  var rows = await dao.history.listAll();
  var dbSeries = {};
  (rows || []).forEach(function (h) {
    var code = h.regionCode;
    var date = String(h.date || '').slice(0, 10);
    if (!code || regionRejected(chain, code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    var price = Number(h.price);
    if (!isFinite(price)) return;
    if (!dbSeries[code]) dbSeries[code] = {};
    if (!dbSeries[code][date]) dbSeries[code][date] = {};
    dbSeries[code][date][h.fuelId] = price;
  });
  return { series: dbSeries, from: 'db' };
}

/**
 * 跨省一致性统计。
 *
 * 对每个 (日期, 油品)：算各省相对**自己上一期**的变化幅度，取跨省中位数与 MAD。
 *
 * ⚠️ 必须用「变化幅度」而不是「绝对价」：
 * 98# 的跨省**绝对价差**天然可达 1.4 元/升（各省 98# 相对 92# 的溢价差 1.3），
 * 拿绝对价判离群会误伤一大片（实测甘肃 98# 天然比中位数低 1.39，属正常）。
 * 变化幅度才是全国统一调价下应当一致的量。
 */
function crossProvinceStats(seriesByCode) {
  var stats = {};
  var codes = Object.keys(seriesByCode);
  var dates = {};
  codes.forEach(function (c) {
    Object.keys(seriesByCode[c]).forEach(function (d) { dates[d] = 1; });
  });
  Object.keys(dates).sort().forEach(function (d) {
    var byFuel = {};
    codes.forEach(function (c) {
      var ser = seriesByCode[c];
      var prevDate = null;
      Object.keys(ser).sort().forEach(function (dd) { if (dd < d) prevDate = dd; });
      if (!prevDate) return;
      shared.FUELS.forEach(function (fuel) {
        var a = ser[prevDate][fuel.id];
        var b = ser[d][fuel.id];
        if (typeof a !== 'number' || typeof b !== 'number') return;
        if (!byFuel[fuel.id]) byFuel[fuel.id] = [];
        byFuel[fuel.id].push({ code: c, change: shared.round2(b - a) });
      });
    });
    stats[d] = {};
    Object.keys(byFuel).forEach(function (f) {
      var list = byFuel[f];
      if (list.length < 5) return;
      var vals = list.map(function (x) { return x.change; });
      stats[d][f] = {
        median: median(vals),
        mad: median(vals.map(function (v) { return Math.abs(v - median(vals)); })),
        changes: list
      };
    });
  });
  return stats;
}

/**
 * 跨省偏离判定。
 * 偏离 > max(CROSS_MIN_LIMIT, CROSS_MAD_FACTOR × MAD) → 该点与全国节奏对不上。
 */
var CROSS_MIN_LIMIT = 0.15;
var CROSS_MAD_FACTOR = 4;

function crossDeviation(stats, date, fuelId, regionCode) {
  var st = stats[date] && stats[date][fuelId];
  if (!st) return null;
  var item = null;
  for (var i = 0; i < st.changes.length; i++) {
    if (st.changes[i].code === regionCode) { item = st.changes[i]; break; }
  }
  if (!item) return null;
  var limit = Math.max(CROSS_MIN_LIMIT, CROSS_MAD_FACTOR * st.mad);
  var deviation = Math.abs(item.change - st.median);
  return {
    change: item.change,
    median: st.median,
    mad: st.mad,
    deviation: Math.round(deviation * 100) / 100,
    limit: Math.round(limit * 100) / 100,
    over: deviation > limit
  };
}

/**
 * 历史价入库（五道闸门）。
 *
 * 历史是**一次性回填**的 —— 库里没有旧值可比，
 * 所以不能用「与上次采集价落差」那套逻辑，要单独设闸门：
 *
 *   G1 区间        3 ≤ price ≤ 20，超出即丢点 + 告警
 *   G2 时序        日期必须升序且不重复（重复的按后一条覆盖）
 *   G3 首尾自洽    历史末行价格必须等于同页现价；
 *                  不等 → **该省历史整省丢弃** + 告警
 *                  （说明解析错位或页面结构变了，半张表比没有表危险）
 *   G4 跨省一致性  同日期同油品，各省变化幅度相对跨省中位数的偏离超限
 *                  → 标记 + 告警，**保留原值**
 *                  ⚠️ 离群点是源站给的值，不是我们猜的 —— 擅自改写才是替来源编数字。
 *                  该丢的是解析错误，不是源站的错。
 *   G5 时序去重    同一 (地区, 油品, 日期) 只留一行（幂等 upsert 兜着）
 *
 * @returns {{ok:boolean, saved:number, dropped:Array, advisories:Array}}
 */
async function saveHistory(source, region, parsed, stats) {
  var dropped = [];
  var advisories = [];
  if (!parsed || !parsed.history || !parsed.history.length) {
    return { ok: true, saved: 0, dropped: dropped, advisories: advisories, skipped: 'NO_HISTORY' };
  }

  // ---- G3 首尾自洽 ----
  var rows = parsed.history.slice();
  var last = rows[rows.length - 1];
  var selfOk = true;
  var mismatchFuel = '';
  shared.FUELS.forEach(function (fuel) {
    if (!selfOk) return;
    if (last.prices[fuel.id] !== parsed.prices[fuel.id]) {
      selfOk = false;
      mismatchFuel = fuel.id;
    }
  });
  if (!selfOk) {
    advisories.push({
      regionCode: region.code,
      regionName: region.name,
      fuelId: mismatchFuel,
      reason: 'HISTORY_PRICE_MISMATCH',
      message: '历史表末行价格与同页现价不符（可能解析错位），该省历史整体丢弃'
    });
    return { ok: true, saved: 0, dropped: dropped, advisories: advisories, skipped: 'PRICE_MISMATCH' };
  }

  // ---- G2 时序 + G5 去重 ----
  var seen = {};
  var docs = [];
  rows.forEach(function (row) {
    if (seen[row.date]) {
      dropped.push({ regionCode: region.code, date: row.date, reason: 'DUPLICATE_DATE', message: '同一天重复的历史价' });
      return;
    }
    seen[row.date] = 1;
    shared.FUELS.forEach(function (fuel) {
      var price = row.prices[fuel.id];
      if (typeof price !== 'number') return;
      // ---- G1 区间 ----
      if (!isFinite(price) || price < 3 || price > 20) {
        dropped.push({
          regionCode: region.code,
          date: row.date,
          fuelId: fuel.id,
          price: price,
          reason: 'PRICE_OUT_OF_RANGE',
          message: '历史价超出合理区间，已丢弃'
        });
        return;
      }
      docs.push({
        regionCode: region.code,
        fuelId: fuel.id,
        date: row.date,
        price: price,
        source: source.id
      });
    });
  });

  // ---- G4 跨省一致性 ----
  // 同一个 (省, 油品) 只报最严重的一条，别一次刷几十条告警
  var worst = {};
  docs.forEach(function (doc) {
    var dev = crossDeviation(stats, doc.date, doc.fuelId, doc.regionCode);
    if (!dev || !dev.over) return;
    var key = doc.regionCode + '|' + doc.fuelId;
    if (!worst[key] || worst[key].deviation < dev.deviation) {
      worst[key] = {
        regionCode: doc.regionCode,
        regionName: region.name,
        fuelId: doc.fuelId,
        date: doc.date,
        deviation: dev.deviation,
        limit: dev.limit,
        median: dev.median,
        change: dev.change
      };
    }
  });
  Object.keys(worst).forEach(function (key) {
    advisories.push({
      regionCode: worst[key].regionCode,
      regionName: worst[key].regionName,
      fuelId: worst[key].fuelId,
      date: worst[key].date,
      reason: 'CROSS_PROVINCE_DEVIATION',
      deviation: worst[key].deviation,
      limit: worst[key].limit,
      message: '该期变化幅度与跨省中位数差 ' + worst[key].deviation +
        '（限 ' + worst[key].limit + '），已保留源站原值待人工核对'
    });
  });

  await dao.history.upsertMany(docs);
  return { ok: true, saved: docs.length, dropped: dropped, advisories: advisories };
}

/* ---------------- 调价节点推导 ---------------- */

/**
 * 从历史价推导调价节点。
 *
 * 官方公告只覆盖最近几轮，走势页要显示全年节点就得从历史推。
 *
 * 每个调价日 = 来源历史表里的一行（来源按调价日给价，日期本身就是调价日）；
 * 四油品幅度取各省变化幅度的**中位数** —— 这是实测值，不是官方公布值。
 *
 * ⚠️ 幅度口径：写进 oil_adjust_events 的 deltas 是「各省挂牌价实测差值」，
 * 展示层必须标「据各地挂牌价测算」，不能写成官方公布值。
 */
function deriveAdjustEvents(seriesByCode, origin) {
  // origin 决定节点记到哪个来源名下：走来源历史表记 xmgcn，
  // 走库内累积历史记 measured-history（别把混合来源的数据说成某一个源的）
  var from = origin || {};
  var dedupSource = from.dedupSource || 'xmgcn-history';
  var sourceId = from.source || 'xmgcn';
  var codes = Object.keys(seriesByCode);
  if (!codes.length) return [];
  var dates = {};
  codes.forEach(function (c) {
    Object.keys(seriesByCode[c]).forEach(function (d) { dates[d] = 1; });
  });
  var out = [];
  Object.keys(dates).sort().forEach(function (d) {
    var byFuel = {};
    codes.forEach(function (c) {
      var ser = seriesByCode[c];
      var prevDate = null;
      Object.keys(ser).sort().forEach(function (dd) { if (dd < d) prevDate = dd; });
      if (!prevDate) return;
      shared.FUELS.forEach(function (fuel) {
        var a = ser[prevDate][fuel.id];
        var b = ser[d][fuel.id];
        if (typeof a !== 'number' || typeof b !== 'number') return;
        if (!byFuel[fuel.id]) byFuel[fuel.id] = [];
        byFuel[fuel.id].push(shared.round2(b - a));
      });
    });
    // 92# 变化中位数为 0 → 这一轮全国都没动（搁浅），不是调价节点
    var base = byFuel['92'] || [];
    if (base.length < 5) return;
    var baseMedian = median(base);
    if (Math.abs(baseMedian) < 0.05) return;
    var deltas = {};
    shared.FUELS.forEach(function (fuel) {
      var list = byFuel[fuel.id];
      if (!list || list.length < 5) return;
      deltas[fuel.id] = median(list);
    });
    out.push({
      dedupKey: shared.dedupKey(dedupSource, '国内成品油价格调整', d),
      date: d,
      title: '国内成品油价格调整',
      deltas: deltas,
      source: sourceId
    });
  });
  return out;
}

/* ---------------- 预测源（kind = forecast） ---------------- */

/**
 * 交叉校核容差（元/升）。
 *
 * 两个源给的是同一套官方挂牌价（四舍五入到分），正常应该**完全一致**。
 * 差 0.02 以上说明其中一个源的值是旧的或错的 → 告警，但不阻断。
 */
var CROSS_CHECK_TOLERANCE = 0.02;

/**
 * 预测源流程：抓抽样省份 → 取下次调价预测 + 与主源现价交叉校核。
 *
 * 预测是全国统一的，取第一个解析成功的即可；
 * 顺带把这几个省的现价跟库里主源写的现价比一比 —— **零额外请求完成一次互校**。
 */
async function collectForecastSource(source, options) {
  var opts = options || {};
  var cache = opts.cache || {};
  var codes = (source.verifyRegions || []).slice();
  if (opts.regionCode) codes = [opts.regionCode];
  if (!codes.length) {
    return { sourceId: source.id, status: 'skipped', reason: 'NO_VERIFY_REGIONS', message: '未配置校核省份' };
  }
  var regions = shared.REGIONS.filter(function (r) {
    return codes.indexOf(r.code) >= 0 && !!regionSlug(source, r);
  });
  if (!regions.length) {
    return { sourceId: source.id, status: 'failed', reason: 'UNKNOWN_REGION', message: '校核省份不存在' };
  }

  var fetched = await fetchRegionPages(source, regions, cache);
  var existing = await loadPricesByRegion();
  var trend = null;
  var sawTrend = false;
  var advisories = [];
  var failures = [];
  var checked = 0;

  regions.forEach(function (region) {
    var r = fetched[region.code];
    if (!r || !r.ok) {
      failures.push({
        regionCode: region.code,
        regionName: region.name,
        reason: r ? r.reason : 'UNKNOWN',
        message: r ? r.message : ''
      });
      return;
    }
    if (!trend && r.parsed.trend) {
      sawTrend = true;
      if (r.parsed.trend.isForecast === false) {
        advisories.push({
          regionCode: region.code,
          regionName: region.name,
          reason: 'WINDOW_NOT_FORECAST',
          date: r.parsed.trend.date,
          direction: r.parsed.trend.direction,
          message: '来源公布的是已执行轮次的结果，不是下次调价预测，未写入窗口'
        });
      } else {
        trend = r.parsed.trend;
      }
    }
    // 交叉校核：这一源的现价 vs 库里主源写的现价
    shared.FUELS.forEach(function (fuel) {
      var mine = r.parsed.prices[fuel.id];
      if (typeof mine !== 'number') return;
      var theirs = existing[region.code] && existing[region.code][fuel.id];
      if (!theirs) return;
      if (theirs.source === source.id) return;
      checked++;
      var diff = Math.abs(mine - theirs.price);
      if (diff > CROSS_CHECK_TOLERANCE) {
        advisories.push({
          regionCode: region.code,
          regionName: region.name,
          fuelId: fuel.id,
          price: mine,
          other: theirs.price,
          otherSource: theirs.source,
          diff: Math.round(diff * 100) / 100,
          reason: 'CROSS_SOURCE_MISMATCH',
          message: '两源现价差 ' + Math.round(diff * 100) / 100 + ' 元/升，需人工核对'
        });
      }
    });
  });

  // 调价窗口只收「还没发生的轮次」。
  // ⚠️ 站点在轮次一过就把区块改成公布**结果**（「油价11月12日24时调整 下跌0.51元/升…」），
  // 那个日期已经过去了 —— 拿它当「下次窗口」会让页面显示一个过期预测。
  var windowSaved = null;
  if (trend) {
    var today = todayStr();
    if (trend.date >= today) {
      windowSaved = await saveWindow(source, trend);
    } else {
      advisories.push({
        reason: 'WINDOW_EXPIRED',
        date: trend.date,
        direction: trend.direction,
        message: '来源公布的是 ' + trend.date + ' 那一轮的' +
          (trend.direction === 'down' ? '下调' : trend.direction === 'up' ? '上调' : '搁浅') +
          '结果，不是下次窗口，未写入'
      });
    }
  }

  // 来源已明确给出结果、却没有给出未来窗口时，旧预测已经失效。
  // 全部抓取失败属于暂时故障，保留最后一条窗口，避免网络抖动清空页面。
  if (sawTrend && !windowSaved) {
    await dao.windows.removeBySource(source.id);
  }

  var result = {
    sourceId: source.id,
    status: failures.length ? 'needsReview' : 'ok',
    saved: regions.length - failures.length,
    checked: checked,
    window: windowSaved,
    advisories: advisories,
    failed: failures
  };
  if (failures.length) {
    result.reason = 'REGION_FAILED';
    result.message = failures.length + ' 个校核省份抓取失败';
  }
  return result;
}

/* ---------------- 口径互校（kind = timeline） ---------------- */

/**
 * 官方调价时间表 → 口径互校。
 *
 * 官方公布的是「每吨涨跌」，挂牌价是「每升」。换算关系：
 *   元/升 = 元/吨 ÷ 1000 × 密度（89# 汽油 0.725、0# 柴油 0.835 kg/L）
 * 92# 相对 89# 标准品还有质量差额，所以实测 ÷ 预期的比值稳定在 1.05~1.25。
 *
 * 比值稳定 → 两套**独立**数据互证通过（实测数据没被污染）；
 * 比值跑偏 → 历史数据有问题，要告警。
 */
var TON_DENSITY = { gasoline: 0.725, diesel: 0.835 };
var RATIO_MIN = 0.9;
var RATIO_MAX = 1.4;

function timelineCrossCheck(timeline, stats) {
  var advisories = [];
  var checked = 0;
  (timeline || []).forEach(function (item) {
    if (!item.gasolineDelta) return;
    var st = stats[item.date];
    if (!st || !st['92']) return;
    var expected = item.gasolineDelta / 1000 * TON_DENSITY.gasoline;
    if (!expected) return;
    var ratio = st['92'].median / expected;
    checked++;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
      advisories.push({
        date: item.date,
        reason: 'TON_RATIO_OUT_OF_RANGE',
        ratio: Math.round(ratio * 100) / 100,
        expected: Math.round(expected * 1000) / 1000,
        measured: st['92'].median,
        ton: item.gasolineDelta,
        message: '官方吨价换算与各省实测对不上（比值 ' + Math.round(ratio * 100) / 100 +
          '），历史数据口径可能漂了'
      });
    }
  });
  return { checked: checked, advisories: advisories };
}

/* ---------------- 调价窗口 ---------------- */

/**
 * 把解析出的下次调价预测写成调价窗口。
 *
 * 预测一律 isOfficial = false。
 *
 * ⚠️ 来源只给整体幅度区间（元/升），**没有**分油品幅度 ——
 * 所以 forecast 里存的是区间本身 { direction, literMin, literMax, estimated }，
 * 以前是把区间中值复制给四个油品当成各自的预测幅度，
 * 那等于替来源猜了四个数（各油品幅度本来就不同），违反「不发布猜测值」。
 * 界面按区间展示：「预计下调 0.08–0.10 元/升（非官方估算）」。
 *
 * 同一窗口日期预测没变就不重复写。
 */
async function saveWindow(source, trend) {
  // 防御性拒绝：isForecast=false 是已公布结果，哪怕调用方绕过采集流程也不能存成预测。
  if (!trend || trend.isForecast === false) return null;
  var forecast = {};
  var basis;
  var dirText = trend.direction === 'up' ? '上调' : trend.direction === 'down' ? '下调' : '搁浅';
  if (trend.direction === 'flat') {
    forecast = { direction: 'flat', literMin: 0, literMax: 0, estimated: true, isForecast: true };
    basis = source.name + '预测（非官方）：本轮预计搁浅不作调整，以正式公告为准。';
  } else if (trend.literMin !== null && trend.literMax !== null) {
    forecast = {
      direction: trend.direction,
      // 正数幅度，方向由 direction 表达
      literMin: trend.literMin,
      literMax: trend.literMax,
      estimated: true,
      isForecast: true
    };
    basis = source.name + '预测（非官方）：预计' + dirText +
      (trend.changeTon !== null ? ' ' + Math.abs(trend.changeTon) + ' 元/吨' : '') +
      '，约 ' + trend.literMin + '–' + trend.literMax + ' 元/升；各油品幅度以正式公告为准。';
  } else {
    // 方向已知但幅度没解析出来：不猜幅度，只给方向
    forecast = { direction: trend.direction, estimated: true, isForecast: true };
    basis = source.name + '预测（非官方）：预计' + dirText + '，幅度待公布，以正式公告为准。';
  }

  var doc = {
    // 去重键 = 来源::日期：多实例并发写同一个窗口时靠它保证只有一条
    dedupKey: [source.id, trend.date].join('::'),
    date: trend.date,
    time: trend.time || '24:00',
    cycleStart: null,
    forecast: forecast,
    // 幅度解析不出来时 forecast 里没有区间，靠这个字段表达方向 ——
    // 前端据此显示「预计上调 · 幅度待公布」，而不是把「幅度未知」当成「持平 0」
    forecastDirection: trend.direction,
    isOfficial: false,
    basis: basis,
    source: source.id
  };
  var old = await dao.windows.latestBySource(source.id);
  if (old && old.date === trend.date &&
      JSON.stringify(old.forecast) === JSON.stringify(forecast) && old.basis === basis) {
    return { deduped: true, date: trend.date };
  }
  await dao.windows.upsert(doc);
  return { deduped: false, date: trend.date };
}

/**
 * 采集公告类来源：列表页 → 详情页两步抓取。
 *
 * 为什么两步：发改委的公告挂在「新闻发布」列表页上，每条只是一个链接，
 * 真正的正文在详情页里。单 URL 模型抓到的只是列表页，解析不出任何字段。
 *
 * 省流量：已入库且已可信的公告不再重复抓详情页。
 * 列表页每轮还是要看一眼 —— 不看就不知道有没有新公告。
 */
async function collectNoticeSource(source, options) {
  var opts = options || {};
  var listUrl = source.listUrl || source.url;
  var fetched = await fetchSource({
    url: listUrl,
    headers: source.headers,
    allowedHosts: source.allowedHosts
  });
  if (!fetched.ok) {
    return { sourceId: source.id, status: 'failed', reason: fetched.reason, message: fetched.message };
  }

  var list = null;
  try {
    list = sources.PARSERS[source.listParser](fetched.body, listUrl);
  } catch (err) {
    list = null;
  }
  if (!list || !list.items || !list.items.length) {
    return {
      sourceId: source.id,
      status: 'needsReview',
      reason: 'PARSE_FAILED',
      message: '列表页抓取成功但解析不出公告链接，已转人工核对'
    };
  }

  // 只取关心的公告（其余是新闻发布会、答记者问，与油价无关）
  var keywords = source.itemTitleKeywords || [];
  var candidates = list.items.filter(function (it) {
    if (!keywords.length) return true;
    return keywords.some(function (kw) {
      return String(it.title || '').indexOf(kw) !== -1;
    });
  });
  var limit = source.maxItems || 5;
  candidates = candidates.slice(0, limit);
  if (!candidates.length) {
    return { sourceId: source.id, status: 'ok', saved: 0, skipped: 0, message: '列表页没有新的调价公告' };
  }

  var saved = [];
  var failures = [];
  var skipped = 0;
  for (var i = 0; i < candidates.length; i++) {
    var item = candidates[i];
    // 已入库且已可信 → 不再抓详情页
    var exist = await dao.notices.findBySourceTitle(source.id, item.title);
    if (exist && exist.reviewStatus === 'approved') {
      skipped++;
      continue;
    }
    var detail = await fetchSource({
      url: item.url,
      headers: source.headers,
      allowedHosts: source.allowedHosts
    });
    if (!detail.ok) {
      failures.push({ title: item.title, url: item.url, reason: detail.reason, message: detail.message });
      continue;
    }
    var parsed = null;
    try {
      parsed = sources.PARSERS[source.parser](detail.body, { title: item.title, url: item.url });
    } catch (err) {
      parsed = null;
    }
    if (!parsed) {
      failures.push({
        title: item.title,
        url: item.url,
        reason: 'PARSE_FAILED',
        message: '公告页抓取成功但解析不出结构化字段，已转人工核对'
      });
      continue;
    }
    parsed.url = item.url;
    var res = await saveNotice(source, parsed);
    saved.push(res);
    // 对来源站点友好：两篇之间停一下，别把人家 WAF 打出火
    await delay(800);
  }

  var hasPending = saved.some(function (s) { return s && s.reviewStatus !== 'approved'; });
  var result = {
    sourceId: source.id,
    status: failures.length || hasPending ? 'needsReview' : 'ok',
    saved: saved.length,
    skipped: skipped,
    candidates: candidates.length,
    failed: failures,
    messages: saved
  };
  if (failures.length) {
    result.reason = 'NOTICE_FETCH_FAILED';
    result.message = failures.length + ' 篇公告抓取或解析失败，已转人工核对';
  } else if (hasPending) {
    // ⚠️ 存疑的公告不能报「同步正常」—— 它必须出现在待核对队列里，
    // 否则前端完全看不出「有条公告没解析出来」，以为一切正常。
    result.reason = 'NOTICE_PENDING';
    result.message = '公告已入库但可信度不足，待人工核对';
  }
  return result;
}

/* ---------------- 主流程 ---------------- */

function collectFromSource(source, options) {
  if (!source.enabled) {
    return Promise.resolve({ sourceId: source.id, status: 'skipped', reason: 'SOURCE_DISABLED', message: '来源未启用' });
  }
  // 地区价格源按降级链逐省抓取
  if (source.kind === 'price') {
    return collectPriceChain([source], options);
  }
  // 预测源：抓抽样省份取预测 + 交叉校核
  if (source.kind === 'forecast') {
    return collectForecastSource(source, options);
  }
  // 公告源是「列表页 → 详情页」两步抓取，也走自己的流程
  if (source.kind === 'notice') {
    return collectNoticeSource(source, options);
  }
  return fetchSource(source).then(function (fetched) {
    if (!fetched.ok) {
      return { sourceId: source.id, status: 'failed', reason: fetched.reason, message: fetched.message };
    }
    var parser = sources.PARSERS[source.parser];
    var parsed = null;
    try {
      parsed = parser ? parser(fetched.body) : null;
    } catch (err) {
      parsed = null;
    }
    if (!parsed) {
      // 解析不出来 —— 进人工核对队列，绝不发布猜测值
      return {
        sourceId: source.id,
        status: 'needsReview',
        reason: 'PARSE_FAILED',
        message: '正文抓取成功但无法解析出结构化字段，已转人工核对'
      };
    }
    if (source.kind === 'market') {
      return saveMarket(source, parsed).then(function () {
        return { sourceId: source.id, status: 'ok' };
      });
    }
    return { sourceId: source.id, status: 'skipped', reason: 'UNKNOWN_KIND' };
  });
}

function run(options) {
  var startedAt = nowIso();
  var opts = options || {};
  // 本轮请求缓存：预测源抽样省份可能和价格链撞上，缓存省一次请求
  var cache = opts.cache || {};
  opts.cache = cache;

  var results = [];
  var needsReview = [];
  var advisories = [];

  function push(result) {
    var bucket = resultBucket(result);
    if (bucket === 'advisory') {
      // 内部源的失败：状态降级为 degraded，不进 needsReview
      result.status = 'degraded';
      result.advisory = true;
    }
    results.push(result);
    var entry = {
      sourceId: result.sourceId,
      reason: result.reason,
      message: result.message,
      at: nowIso()
    };
    if (bucket === 'needsReview') needsReview.push(entry);
    else if (bucket === 'advisory') advisories.push(entry);
  }

  var enabled = sources.SOURCES.filter(function (s) { return s.enabled; });
  var priceSources = enabled
    .filter(function (s) { return (s.provides || []).indexOf('price') >= 0; })
    .sort(function (a, b) { return (a.priority || 99) - (b.priority || 99); });
  var forecastSources = enabled.filter(function (s) { return s.kind === 'forecast'; });
  var timelineSources = enabled.filter(function (s) { return s.kind === 'timeline'; });
  var noticeSources = enabled.filter(function (s) { return s.kind === 'notice'; });
  var marketSources = enabled.filter(function (s) { return s.kind === 'market'; });

  var chain = null;
  var series = {};
  var stats = null;
  var timelineItems = [];

  return Promise.resolve()
    .then(function () {
      if (!priceSources.length) {
        push({ sourceId: '-', status: 'skipped', reason: 'NO_PRICE_SOURCE', message: '没有启用的价格源' });
        return null;
      }
      // ---- 1. 价格源降级链 ----
      // 抓完先不写：历史入库的跨省闸门要等所有省都齐了才能算
      return collectPriceChain(priceSources, opts).then(function (r) { chain = r; });
    })
    .then(function () {
      if (!chain || !Object.keys(chain.adopted).length) return null;
      // ---- 2. 现价入库（跳变闸门 + 基准价告警）----
      var existing = null;
      chain.rejected = {};
      return loadPricesByRegion().then(function (ex) {
        existing = ex;
        var saved = 0;
        var advisories = [];
        var failures = [];
        var codes = Object.keys(chain.adopted);
        var promise = Promise.resolve();
        codes.forEach(function (code) {
          promise = promise.then(function () {
            var region = shared.REGIONS.filter(function (r) { return r.code === code; })[0];
            if (!region) return;
            var item = chain.adopted[code];
            return saveRegionPrices(item.source, region, item.parsed, existing).then(function (res) {
              if (!res.ok) {
                chain.rejected[code] = true;
                failures.push({
                  regionCode: code,
                  regionName: region.name,
                  reason: res.reason,
                  message: res.message
                });
                return;
              }
              saved++;
              if (res.advisory && res.advisory.length) {
                advisories.push({ regionCode: code, regionName: region.name, items: res.advisory });
              }
            });
          });
        });
        return promise.then(function () {
          chain.saved = saved;
          chain.priceAdvisories = advisories;
          chain.priceFailures = failures;
        });
      });
    })
    .then(function () {
      if (!chain) return null;
      // ---- 3. 历史入库（五道闸门）----
      // 序列优先取当轮解析出来的来源历史；主源被站点拒绝时回落到库内累积历史
      // （见 buildSeries 的说明：不回落的话调价节点会静默停更）
      return buildSeries(chain).then(function (built) {
        var series = built.series;
        if (!Object.keys(series).length) return null;
        var stats = crossProvinceStats(series);
        var historyAdvisories = [];
        var historyDropped = [];
        var historySaved = 0;
        var promise = Promise.resolve();
        var codes = Object.keys(chain.adopted).filter(function (code) {
          return !regionRejected(chain, code);
        });
        codes.forEach(function (code) {
          promise = promise.then(function () {
            var region = shared.REGIONS.filter(function (r) { return r.code === code; })[0];
            if (!region) return;
            var item = chain.adopted[code];
            return saveHistory(item.source, region, item.parsed, stats).then(function (res) {
              historySaved += res.saved || 0;
              if (res.advisories && res.advisories.length) {
                historyAdvisories = historyAdvisories.concat(res.advisories);
              }
              if (res.dropped && res.dropped.length) {
                historyDropped = historyDropped.concat(res.dropped);
              }
            });
          });
        });
        return promise.then(function () {
          chain.historySaved = historySaved;
          chain.historyAdvisories = historyAdvisories;
          chain.historyDropped = historyDropped;
          chain.seriesFrom = built.from;
          // ---- 4. 调价节点：从历史实测推导全年节点 ----
          // ⚠️ 去重键两条路径共用（'xmgcn-history'）：同一个调价日算出来的节点
          //    日期与幅度是一样的，换键会在库里留下两行同一天的节点。
          var origin = built.from === 'db'
            ? { source: 'measured-history', dedupSource: 'xmgcn-history' }
            : { source: 'xmgcn', dedupSource: 'xmgcn-history' };
          var events = deriveAdjustEvents(series, origin);
          return dao.events.upsertMany(events).then(function () {
            chain.adjustEvents = events.length;
            chain.stats = stats;
          });
        });
      });
    })
    .then(function () {
      // ---- 5. 口径互校：官方吨价 → 每升，跟各省实测中位数比一比 ----
      //
      // ⚠️ 主路径用**发改委公告里的官方吨价**（已经在库里，零额外请求）：
      //     权威一手来源，不会因为某个第三方站点关页面就整个失效 ——
      //     2026-11-24 实测 xmgcn 的调价时间表页返回「HTTP 200 + nginx 403 错误页」。
      //
      // xmgcn 的时间表只作**补充**（它覆盖的历史轮次更多，拿得到就多校几轮）。
      // 它是内部互校源：失败只记告警，不把用户看到的「等待人工核对」点亮 ——
      // 它的数据根本不进界面，它挂了用户看到的价还是对的。
      var stats = chain && chain.stats ? chain.stats : {};
      var promise = Promise.resolve();

      // ---- 5a. 发改委公告吨价（主路径）----
      promise = promise.then(function () {
        return dao.notices.listApprovedWithTon(60).then(function (rows) {
          var rounds = tonRoundsFromNotices(rows);
          var check = timelineCrossCheck(rounds, stats);
          if (!check.checked) {
            // 没有可比对的轮次 → 说清楚是「没得比」，不能报「互证通过」
            push({
              sourceId: 'ndrc-ton',
              sourceName: '发改委公告吨价',
              status: 'skipped',
              rounds: rounds.length,
              checked: 0,
              message: '官方吨价轮次 ' + rounds.length + ' 条，但没有可互校的历史实测值'
            });
            return null;
          }
          push({
            sourceId: 'ndrc-ton',
            sourceName: '发改委公告吨价',
            status: check.advisories.length ? 'needsReview' : 'ok',
            rounds: rounds.length,
            checked: check.checked,
            advisories: check.advisories,
            message: check.advisories.length
              ? '官方吨价与各省实测口径对不上，待人工核对'
              : '官方吨价与各省实测互证通过（' + check.checked + ' 轮）'
          });
          return null;
        });
      });

      // ---- 5b. 第三方调价时间表（补充，内部源）----
      timelineSources.forEach(function (src) {
        promise = promise.then(function () {
          return fetchSource({
            id: src.id,
            url: src.url,
            headers: src.headers,
            allowedHosts: src.allowedHosts
          }).then(function (fetched) {
            if (!fetched.ok) {
              push({
                sourceId: src.id,
                sourceName: src.name,
                status: 'failed',
                internal: true,
                reason: fetched.reason,
                message: fetched.message
              });
              return null;
            }
            var parsed = null;
            try {
              parsed = sources.PARSERS[src.parser](fetched.body);
            } catch (err) {
              parsed = null;
            }
            if (!parsed) {
              push({
                sourceId: src.id,
                sourceName: src.name,
                status: 'needsReview',
                internal: true,
                reason: 'PARSE_FAILED',
                message: '时间表抓取成功但解析不出调价轮次（内部互校源，不影响对外数据）'
              });
              return null;
            }
            var check = timelineCrossCheck(parsed.items, stats);
            push({
              sourceId: src.id,
              sourceName: src.name,
              status: check.advisories.length ? 'needsReview' : 'ok',
              internal: true,
              rounds: parsed.items.length,
              checked: check.checked,
              advisories: check.advisories,
              message: check.advisories.length
                ? '官方吨价与各省实测口径对不上（补充互校）'
                : '官方吨价与各省实测互证通过（' + check.checked + ' 轮，补充互校）'
            });
            return null;
          });
        });
      });

      return promise;
    })
    .then(function () {
      // ---- 6. 预测源 + 交叉校核 ----
      var promise = Promise.resolve();
      forecastSources.forEach(function (src) {
        promise = promise.then(function () {
          return collectForecastSource(src, opts).then(push);
        });
      });
      return promise;
    })
    .then(function () {
      // ---- 7. 公告源 ----
      var promise = Promise.resolve();
      noticeSources.forEach(function (src) {
        promise = promise.then(function () {
          return collectNoticeSource(src, opts).then(push);
        });
      });
      return promise;
    })
    .then(function () {
      // ---- 8. 国际行情源 ----
      var promise = Promise.resolve();
      marketSources.forEach(function (src) {
        promise = promise.then(function () {
          return collectMarketSource(src).then(push);
        });
      });
      return promise;
    })
    .then(function () {
      // ---- 9. 汇总价格链结果 ----
      // 先按来源分别报一遍：主源被拒、备源接管了多少省份，
      // 必须能从「来源健康」里看出来（以前只看最终结果，主源全挂也看不出来）
      if (chain && chain.sourceStats) {
        chain.sourceStats.forEach(function (st) {
          var reasons = Object.keys(st.reasons || {}).map(function (k) {
            return k + '×' + st.reasons[k];
          }).join('、');
          // 这个源没抓到的地区里，有多少是被**别的源接住**的 ——
          // 「没抓到」和「备源接住了」是两回事，界面不能混着说
          var takenOver = (st.failedRegions || []).filter(function (code) {
            var adopted = chain.adopted[code];
            return !!adopted && !regionRejected(chain, code) &&
              adopted.source && adopted.source.id !== st.sourceId;
          }).length;
          push({
            sourceId: st.sourceId,
            sourceName: st.name,
            status: st.failed ? 'degraded' : 'ok',
            saved: st.ok,
            tried: st.tried,
            failed: st.failed,
            takenOver: takenOver,
            degraded: (st.failedRegions || []).map(function (code) {
              return { regionCode: code };
            }),
            message: st.failed
              ? (st.name + ' 有 ' + st.failed + ' 个地区抓不到（' + (reasons || '未知原因') + '）' +
                (takenOver ? '，其中 ' + takenOver + ' 个由备源接住' : ''))
              : (st.name + ' 供数 ' + st.ok + ' 个地区')
          });
        });
      }
      if (chain) {
        var priceFailures = (chain.failures || []).concat(chain.priceFailures || []);
        var priceStatus = priceFailures.length ? 'needsReview' : 'ok';
        push({
          sourceId: chain.adopted && Object.keys(chain.adopted).length
            ? (Object.keys(chain.adopted)[0] && chain.adopted[Object.keys(chain.adopted)[0]].source.id)
            : '-',
          status: priceStatus,
          saved: chain.saved || 0,
          fresh: chain.fresh || 0,
          stale: chain.stale || 0,
          historySaved: chain.historySaved || 0,
          adjustEvents: chain.adjustEvents || 0,
          failed: priceFailures,
          degraded: chain.degraded || [],
          advisories: (chain.priceAdvisories || []).concat(chain.historyAdvisories || []),
          message: priceFailures.length
            ? priceFailures.length + ' 个地区采集或价格校验失败，已转人工核对'
            : '历史价 ' + (chain.historySaved || 0) + ' 条、调价节点 ' + (chain.adjustEvents || 0) + ' 个'
        });
      }
      // 真实来源一个都没启用时，状态是 idle —— 不能报「同步正常」，
      // 否则前端会让人以为后台在真实采集。
      var allSkipped = results.length > 0 && results.every(function (r) { return r.status === 'skipped'; });
      var runDoc = {
        startedAt: startedAt,
        finishedAt: nowIso(),
        // needsReview 里只剩**用户侧**来源的失败：内部源的问题走 advisories，
        // 不该让用户看到「等待人工核对」。
        status: allSkipped ? 'idle' : (needsReview.length ? 'partial' : 'ok'),
        sourceName: '服务端定时采集',
        results: results,
        needsReview: needsReview,
        advisories: advisories
      };
      return dao.runs.insert(runDoc).then(function () { return runDoc; });
    })
    .catch(function (err) {
      console.error('[collector] 运行失败', err);
      return dao.runs.insert({
        startedAt: startedAt,
        finishedAt: nowIso(),
        status: 'error',
        sourceName: '服务端定时采集',
        results: [],
        needsReview: [{ sourceId: '-', reason: 'INTERNAL_ERROR', message: err.message || String(err), at: nowIso() }]
      }).then(function () { throw err; });
    });
}

module.exports = {
  run: run,
  collectFromSource: collectFromSource,
  // 下面这几个是给自检钉住行为的纯函数
  fetchSource: fetchSource,
  resultBucket: resultBucket,
  isUserFacingSource: isUserFacingSource,
  tonRoundsFromNotices: tonRoundsFromNotices,
  buildSeries: buildSeries,
  saveNotice: saveNotice,
  saveWindow: saveWindow,
  saveRegionPrices: saveRegionPrices,
  saveHistory: saveHistory,
  historySeries: historySeries,
  crossDeviation: crossDeviation,
  collectPriceChain: collectPriceChain,
  collectForecastSource: collectForecastSource,
  collectMarketSource: collectMarketSource,
  mergeMarketPoints: mergeMarketPoints,
  deriveAdjustEvents: deriveAdjustEvents,
  crossProvinceStats: crossProvinceStats,
  timelineCrossCheck: timelineCrossCheck,
  regionSlug: regionSlug,
  regionUrl: regionUrl,
  todayStr: todayStr
};
