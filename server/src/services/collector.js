/**
 * 定时采集
 *
 * 业务逻辑从 cloudfunctions/oilCollector/index.js 原样搬过来，
 * 只把云数据库调用换成 DAO。
 *
 * 关键约束不变：
 *   1. 解析失败不猜测，进 needsReview 人工核对队列；
 *   2. 通知按 dedupKey 去重，重复抓取不会重复入库；
 *   3. 每次运行都写 collector_runs，前端据此展示「同步状态」。
 *
 * 地区价格源（qiyoujiage）：价格只在调价日变化，默认 6 小时新鲜期，
 * 31 省 3 并发抓取；run({ regionCode, force }) 可单地区强制采集。
 */
const https = require('https');
const http = require('http');
const dao = require('../dao');
const shared = require('../shared/shared');
const sources = require('./sources');

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

function fetchSource(source) {
  if (!source.url) {
    return Promise.resolve({ ok: false, reason: 'NO_URL', message: '来源未配置地址' });
  }
  return new Promise(function (resolve) {
    var target;
    try {
      target = new URL(source.url);
    } catch (e) {
      resolve({ ok: false, reason: 'URL_INVALID', message: '来源地址不合法' });
      return;
    }
    var lib = target.protocol === 'https:' ? https : http;
    var req = lib.request(target.toString(), {
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'oil-trend-collector/1.0' }, source.headers || {})
    }, function (res) {
      var chunks = [];
      var size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > 5 * 1024 * 1024) {
          req.destroy();
          resolve({ ok: false, reason: 'RESPONSE_TOO_LARGE', message: '响应体过大' });
          return;
        }
        chunks.push(c);
      });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          resolve({ ok: false, reason: 'HTTP_' + res.statusCode, message: '接口返回异常状态码' });
          return;
        }
        resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(15000, function () {
      req.destroy();
      resolve({ ok: false, reason: 'FETCH_TIMEOUT', message: '抓取超时' });
    });
    req.on('error', function (err) {
      resolve({ ok: false, reason: 'FETCH_ERROR', message: err.message || String(err) });
    });
    req.end();
  });
}

/* ---------------- 入库 ---------------- */

/** 去重入库：同一来源 + 执行日期 + 标题 只保留一条 */
function saveNotice(source, parsed) {
  var key = shared.dedupKey(source.id, parsed.title, parsed.executeAt);
  return dao.notices.findByDedupKey(key).then(function (exist) {
    if (exist) return { deduped: true, id: exist.id };
    return dao.notices.insert({
      dedupKey: key,
      kind: parsed.kind,
      title: parsed.title,
      publishedAt: nowIso(),
      executeAt: parsed.executeAt || '',
      // 各油品幅度本来就不同，不能把同一个值复制给四个油品
      changes: parsed.deltas || { '92': parsed.delta, '95': parsed.delta, '98': parsed.delta, '0': parsed.delta },
      // 采集结果默认待复核，复核通过才对外可见
      reviewStatus: parsed.reviewStatus || 'pending',
      summary: parsed.perFuel
        ? '来源正文解析结果，待人工复核后对外发布。'
        : '来源正文只解析出总幅度，各油品幅度待人工核对。',
      prices: {},
      source: { sourceId: source.id, name: source.name, url: source.url, publishedAt: nowIso() },
      raw: parsed.raw || ''
    }).then(function (doc) {
      return { deduped: false, id: doc.id };
    });
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
      await saveRegionPrices(source, region, parsed, existing);
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
    window: windowSaved
  };
  if (failures.length) {
    result.reason = 'REGION_FAILED';
    result.message = failures.length + ' 个地区采集失败，已转人工核对';
  }
  return result;
}

/**
 * 入库一个地区的四油品价格。
 * 涨跌只跟同来源旧价比：seed 演示价不是真实旧价，差值没有意义。
 * 首次真实采集 changeAmount 记 0、changeAt 留空（不知道上次调价日），
 * 但会写一条今日历史价作为走势起点。
 */
async function saveRegionPrices(source, region, parsed, existing) {
  var today = todayStr();
  var priceDocs = [];
  var historyDocs = [];
  shared.FUELS.forEach(function (fuel) {
    var price = parsed.prices[fuel.id];
    if (price === undefined) return;
    var old = existing[region.code] && existing[region.code][fuel.id];
    var oldReal = old && old.source === source.id ? old : null;
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
    if (changed) {
      // 历史价按 (地区, 油品, 日期) 唯一索引去重：同一天重复抓只更新价格
      historyDocs.push({ regionCode: region.code, fuelId: fuel.id, date: today, price: price, source: source.id });
    }
  });
  await dao.prices.upsertMany(priceDocs);
  await dao.history.upsertMany(historyDocs);
}

/**
 * 把解析出的下次调价预测写成调价窗口。
 * 预测一律 isOfficial = false；来源只给整体幅度区间（元/升），没有分油品
 * 幅度，四个油品都用区间中值 —— 这是预测口径，basis 里写明以正式公告为准。
 * 同一窗口日期预测没变就不重复写。
 */
async function saveWindow(source, trend) {
  var forecast = {};
  var basis;
  var dirText = trend.direction === 'up' ? '上调' : trend.direction === 'down' ? '下调' : '搁浅';
  if (trend.direction === 'flat') {
    shared.FUELS.forEach(function (f) { forecast[f.id] = 0; });
    basis = source.name + '预测（非官方）：本轮预计搁浅不作调整，以正式公告为准。';
  } else if (trend.literMin !== null && trend.literMax !== null) {
    var sign = trend.direction === 'down' ? -1 : 1;
    var mid = shared.round2((trend.literMin + trend.literMax) / 2) * sign;
    shared.FUELS.forEach(function (f) { forecast[f.id] = mid; });
    basis = source.name + '预测（非官方）：预计' + dirText +
      (trend.changeTon !== null ? ' ' + Math.abs(trend.changeTon) + ' 元/吨' : '') +
      '，约 ' + trend.literMin + '–' + trend.literMax + ' 元/升；各油品幅度以正式公告为准。';
  } else {
    // 方向已知但幅度没解析出来：不猜幅度，forecast 留空
    basis = source.name + '预测（非官方）：预计' + dirText + '，幅度待公布，以正式公告为准。';
  }

  var doc = {
    date: trend.date,
    time: trend.time || '24:00',
    cycleStart: null,
    forecast: forecast,
    // 幅度解析不出来时 forecast 是空对象，方向单独存 ——
    // 前端据此显示「预计上调 · 幅度待公布」，而不是把未知当成持平 0
    forecastDirection: trend.direction,
    isOfficial: false,
    basis: basis,
    source: source.id
  };
  var old = await dao.windows.latestBySource(source.id);
  if (old && old.date === trend.date) {
    if (JSON.stringify(old.forecast) === JSON.stringify(forecast) && old.basis === basis) {
      return { deduped: true, date: trend.date };
    }
    await dao.windows.update(old.id, doc);
  } else {
    await dao.windows.insert(doc);
  }
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

module.exports = { run: run, collectFromSource: collectFromSource };
