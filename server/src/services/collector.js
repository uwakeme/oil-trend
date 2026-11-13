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
 * 地区价格源（qiyoujiage）：价格只在调价日变化，默认 6 小时新鲜期，
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

/* ---------------- 抓取 ---------------- */

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
    // 重定向只允许跳到白名单里的主机
    allowedHosts: source.allowedHosts || []
  }).then(function (res) {
    if (res.statusCode !== 200) {
      return { ok: false, reason: 'HTTP_' + res.statusCode, message: '接口返回异常状态码' };
    }
    return { ok: true, body: res.body };
  }).catch(function (err) {
    var msg = (err && err.message) || String(err);
    var reason = msg === 'TIMEOUT' ? 'FETCH_TIMEOUT'
      : (msg === 'TOTAL_TIMEOUT' ? 'FETCH_TIMEOUT'
      : (msg === 'RESPONSE_TOO_LARGE' ? 'RESPONSE_TOO_LARGE'
      : (msg === 'URL_INVALID' ? 'URL_INVALID'
      : (msg === 'TOO_MANY_REDIRECTS' ? 'TOO_MANY_REDIRECTS'
      : (msg === 'REDIRECT_BLOCKED' ? 'REDIRECT_BLOCKED'
      : (msg === 'PROTOCOL_UNSUPPORTED' ? 'PROTOCOL_UNSUPPORTED' : 'FETCH_ERROR'))))));
    return { ok: false, reason: reason, message: msg };
  });
}

/* ---------------- 入库 ---------------- */

/**
 * 通知摘要：说清楚这条是怎么来的、还缺什么。
 *
 * 对外可见的只有 approved，文案里不能出现「待复核」这种自相矛盾的说法。
 */
function noticeSummary(parsed) {
  if (parsed.reviewStatus === 'approved') {
    return '来源公告逐项列明各油品调整幅度，已按原文发布。';
  }
  if (!parsed.perFuel) {
    return '来源公告只解析出总幅度（每升 ' + parsed.delta + ' 元/升），各油品幅度待人工核对。';
  }
  return '来源公告未解析出执行日期，待人工核对后发布。';
}

/**
 * 采集到一条可信的正式公告时，同步补写调价节点。
 *
 * ⚠️ oil_adjust_events 这张表以前只有测试夹具在写，生产库一直是空的，
 * 走势页的调价节点恒不显示（count 恒 0）。
 * 这里在公告入库的同时补一条，靠 dedup_key 保证不重复。
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
    executeAt: parsed.executeAt || '',
    // 只放逐项解析出来的幅度。没有就是没有，
    // 不能拿总幅度复制给四个油品 —— 那是猜的，不能进正式结果。
    changes: parsed.deltas || {},
    reviewStatus: parsed.reviewStatus || 'pending',
    summary: noticeSummary(parsed),
    prices: {},
    source: { sourceId: source.id, name: source.name, url: source.url, publishedAt: nowIso() },
    raw: parsed.raw || ''
  };

  return dao.notices.findByDedupKey(key).then(function (exist) {
    if (!exist) {
      return dao.notices.insert(Object.assign({ dedupKey: key }, doc)).then(function (inserted) {
        // 可信的公告顺手补一条调价节点，走势页才有调价节点可显示
        var follow = doc.reviewStatus === 'approved'
          ? saveAdjustEvent(source, parsed)
          : Promise.resolve(null);
        return follow.then(function () {
          return { deduped: false, id: inserted.id };
        });
      });
    }
    // 存疑的遇到可信的 → 用更可信的结果覆盖
    if (exist.reviewStatus !== 'approved' && doc.reviewStatus === 'approved') {
      return dao.notices.update(exist.id, Object.assign({}, doc, { publishedAt: exist.publishedAt }))
        .then(function () {
          return saveAdjustEvent(source, parsed).then(function () {
            return { deduped: false, upgraded: true, id: exist.id };
          });
        });
    }
    return { deduped: true, id: exist.id };
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

/**
 * 逐地区抓取价格页。
 * options.regionCode 只采一个地区（手动触发/联调用）；options.force 忽略新鲜期。
 * 价格只在调价日变化，默认 freshHours 内抓过的地区跳过。
 */
async function collectPriceSource(source, options) {
  var opts = options || {};
  var regions = shared.REGIONS.filter(function (r) { return r.slug; });
  if (opts.regionCode) {
    regions = regions.filter(function (r) { return r.code === opts.regionCode; });
    if (!regions.length) {
      return { sourceId: source.id, status: 'failed', reason: 'UNKNOWN_REGION', message: '地区代码不存在：' + opts.regionCode };
    }
  }

  var existing = await loadPricesByRegion();
  var freshHours = source.freshHours || 6;
  var stale = regions.filter(function (r) {
    return opts.force || !regionFresh(existing[r.code], source.id, freshHours);
  });
  if (!stale.length) {
    // 数据仍是真实且新鲜的，报 ok 而不是 idle —— idle 的文案是「真实数据源尚未接入」
    return { sourceId: source.id, status: 'ok', saved: 0, fresh: regions.length, message: '全部地区价格仍在新鲜期内' };
  }

  var saved = 0;
  var failures = [];
  var advisories = [];
  var trend = null;
  // 3 个并发 worker：31 个省页一次全开对对方站点不友好
  var queue = stale.slice();
  async function worker() {
    while (queue.length) {
      var region = queue.shift();
      var fetched = await fetchSource({ url: source.url + region.slug + '.shtml', headers: source.headers });
      if (!fetched.ok) {
        failures.push({ regionCode: region.code, regionName: region.name, reason: fetched.reason, message: fetched.message });
        continue;
      }
      var parsed = null;
      try {
        parsed = sources.PARSERS[source.parser](fetched.body);
      } catch (err) {
        parsed = null;
      }
      if (!parsed) {
        failures.push({ regionCode: region.code, regionName: region.name, reason: 'PARSE_FAILED', message: '页面抓取成功但解析不出四油品价格，转人工核对' });
        continue;
      }
      var saveResult = await saveRegionPrices(source, region, parsed, existing);
      if (!saveResult.ok) {
        failures.push({
          regionCode: region.code,
          regionName: region.name,
          reason: saveResult.reason,
          message: saveResult.message
        });
        continue;
      }
      if (saveResult.advisory && saveResult.advisory.length) {
        advisories.push({
          regionCode: region.code,
          regionName: region.name,
          items: saveResult.advisory
        });
      }
      saved++;
      // 各省页面的预测是全国统一的，取第一个解析成功的即可
      if (!trend && parsed.trend) trend = parsed.trend;
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  var windowSaved = null;
  if (trend) windowSaved = await saveWindow(source, trend);

  var result = {
    sourceId: source.id,
    status: failures.length ? 'needsReview' : 'ok',
    saved: saved,
    fresh: regions.length - stale.length,
    failed: failures,
    // 与基准价偏差偏大的地区：只记告警，不影响价格入库
    advisories: advisories,
    window: windowSaved
  };
  if (failures.length) {
    result.reason = 'REGION_FAILED';
    result.message = failures.length + ' 个地区采集失败，已转人工核对';
  }
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
 * 正常一轮调价在 0.3 元以内。跳超过 1 元，基本只有两种可能：
 * 页面结构变了导致解析错位，或者链路被动手脚注入了假价。
 */
var JUMP_LIMIT = 1.0;

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
 * 入库一个地区的四油品价格。
 * 涨跌只跟同来源旧价比：seed 演示价不是真实旧价，差值没有意义。
 * 首次真实采集 changeAmount 记 0、changeAt 留空（不知道上次调价日），
 * 界面据此显示「暂无调价对比」，不假装成持平。
 * 历史价每轮都写当天生效的挂牌价（按日期幂等覆盖）。
 *
 * ⚠️ 入库前要过两道校验（价格源只能走 HTTP，链路上能被动手脚）：
 *   1. 与库里上一次真实价比 —— 落差超 1 元就不入库，转人工核对；
 *   2. 与各省基准价比 —— 偏差超 1.5 元只记告警，不阻断。
 */
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
    // 正常一轮调价在 0.3 元以内，跳超过 1 元基本只有两种可能：
    // 页面结构变了导致解析错位，或者链路被动手脚注入了假价。
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

    var changed = !oldReal || oldReal.price !== price;
    priceDocs.push({
      regionCode: region.code,
      regionName: region.name + ' · ' + region.city,
      fuelId: fuel.id,
      fuelName: fuel.name,
      price: price,
      changeAmount: oldReal && changed ? shared.round2(price - oldReal.price) : (oldReal ? oldReal.changeAmount : 0),
      changeAt: oldReal && changed ? today : (oldReal ? oldReal.changeAt : null),
      source: source.id
    });
    // 历史价记的是「当天生效的挂牌价」，所以每轮都写：
    // 按 (地区, 油品, 日期) 唯一索引幂等覆盖，一天最多一行。
    // 以前只在价格变化时写，30 天没调价就只剩起点的 1 个点，
    // 走势图连一条横线都画不出来 —— 阶梯线的横段本来就该是平的。
    historyDocs.push({ regionCode: region.code, fuelId: fuel.id, date: today, price: price, source: source.id });
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
  var forecast = {};
  var basis;
  var dirText = trend.direction === 'up' ? '上调' : trend.direction === 'down' ? '下调' : '搁浅';
  if (trend.direction === 'flat') {
    forecast = { direction: 'flat', literMin: 0, literMax: 0, estimated: true };
    basis = source.name + '预测（非官方）：本轮预计搁浅不作调整，以正式公告为准。';
  } else if (trend.literMin !== null && trend.literMax !== null) {
    forecast = {
      direction: trend.direction,
      // 正数幅度，方向由 direction 表达
      literMin: trend.literMin,
      literMax: trend.literMax,
      estimated: true
    };
    basis = source.name + '预测（非官方）：预计' + dirText +
      (trend.changeTon !== null ? ' ' + Math.abs(trend.changeTon) + ' 元/吨' : '') +
      '，约 ' + trend.literMin + '–' + trend.literMax + ' 元/升；各油品幅度以正式公告为准。';
  } else {
    // 方向已知但幅度没解析出来：不猜幅度，只给方向
    forecast = { direction: trend.direction, estimated: true };
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

/* ---------------- 主流程 ---------------- */

function collectFromSource(source, options) {
  if (!source.enabled) {
    return Promise.resolve({ sourceId: source.id, status: 'skipped', reason: 'SOURCE_DISABLED', message: '来源未启用' });
  }
  // 地区价格源按地区逐个抓取，不走单 URL 流程
  if (source.kind === 'price') {
    return collectPriceSource(source, options);
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
    if (source.kind === 'notice') {
      return saveNotice(source, parsed).then(function (saved) {
        return { sourceId: source.id, status: 'ok', saved: saved };
      });
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
  var results = [];
  var needsReview = [];

  return sources.SOURCES.reduce(function (chain, source) {
    return chain.then(function () {
      return collectFromSource(source, options).then(function (result) {
        results.push(result);
        if (result.status === 'needsReview' || result.status === 'failed') {
          needsReview.push({
            sourceId: result.sourceId,
            reason: result.reason,
            message: result.message,
            at: nowIso()
          });
        }
      });
    });
  }, Promise.resolve()).then(function () {
    // 真实来源一个都没启用时，状态是 idle —— 不能报「同步正常」，
    // 否则前端会让人以为后台在真实采集。
    var allSkipped = results.length > 0 && results.every(function (r) { return r.status === 'skipped'; });
    var runDoc = {
      startedAt: startedAt,
      finishedAt: nowIso(),
      status: allSkipped ? 'idle' : (needsReview.length ? 'partial' : 'ok'),
      sourceName: '服务端定时采集',
      results: results,
      needsReview: needsReview
    };
    return dao.runs.insert(runDoc).then(function () { return runDoc; });
  }).catch(function (err) {
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
  saveNotice: saveNotice,
  saveWindow: saveWindow,
  // 导出给自检用：历史价「价格没变也要记」这条规则要被钉住
  saveRegionPrices: saveRegionPrices
};
