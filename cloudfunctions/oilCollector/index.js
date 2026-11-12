/**
 * 油势 · 定时采集云函数
 *
 * 流程（与设计文档第 6 节一致）：
 *   官方来源 → 原始内容快照 → 解析与字段校验 → 去重入库 → 更新价格与通知
 *
 * 关键约束：
 *   1. 解析失败不猜测，进入 needsReview 人工核对队列；
 *   2. 通知按 dedupKey 去重，重复抓取不会重复入库；
 *   3. 每次运行都写 collector_runs，前端据此展示「同步状态」，
 *      数据过期或失败时如实说明，不假装实时。
 *
 * 触发方式：
 *   - 定时触发器（默认每 30 分钟）
 *   - 手动调用 event.action = 'collect' 立即采集
 *     （可带 regionCode 只采一个地区、force: true 忽略新鲜期）
 *   - 手动调用 event.action = 'seed'   写入演示数据（用于打通云端链路）
 *
 * 地区价格源（qiyoujiage）：价格只在调价日变化，默认 6 小时新鲜期，
 * 31 省 3 并发抓取；首次全量采集耗时较长，config.json 超时设为 60s。
 */
const cloud = require('wx-server-sdk');
const shared = require('./shared');
const sources = require('./sources');
const httpClient = require('./http-client');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const C = {
  prices: 'oil_prices',
  history: 'oil_price_history',
  events: 'oil_adjust_events',
  notices: 'oil_notices',
  windows: 'oil_windows',
  markets: 'oil_markets',
  runs: 'collector_runs'
};

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  // 统一按 UTC+8 日历日算：云函数跑在 UTC，直接用本地时区会在早上 8 点前差一天
  var d = new Date(Date.now() + 8 * 3600000);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/* ---------------- 抓取与解析 ---------------- */

async function fetchSource(source) {
  if (!source.url) {
    return { ok: false, reason: 'NO_URL', message: '来源未配置地址' };
  }
  try {
    // 注意用的是 http-client 而不是 SDK 内置的 httpclient：
    // wx-server-sdk 4.x 底层换成 @cloudbase/node-sdk 后已经没有这个 API 了。
    var res = await httpClient.get(source.url, {
      headers: Object.assign({ 'User-Agent': 'oil-trend-collector/1.0' }, source.headers || {}),
      timeout: 15000
    });
    if (res.statusCode !== 200) {
      return { ok: false, reason: 'HTTP_' + res.statusCode, message: '接口返回异常状态码' };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    return { ok: false, reason: 'FETCH_ERROR', message: (err && err.message) || String(err) };
  }
}

async function collectFromSource(source, options) {
  if (!source.enabled) {
    return { sourceId: source.id, status: 'skipped', reason: 'SOURCE_DISABLED', message: '来源未启用' };
  }
  // 地区价格源按地区逐个抓取，不走单 URL 流程
  if (source.kind === 'price') {
    return collectPriceSource(source, options);
  }
  var fetched = await fetchSource(source);
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
    var saved = await saveNotice(source, parsed);
    return { sourceId: source.id, status: 'ok', saved: saved };
  }
  if (source.kind === 'market') {
    await saveMarket(source, parsed);
    return { sourceId: source.id, status: 'ok' };
  }
  return { sourceId: source.id, status: 'skipped', reason: 'UNKNOWN_KIND' };
}

/** 去重入库：同一来源 + 执行日期 + 标题 只保留一条 */
async function saveNotice(source, parsed) {
  var key = shared.dedupKey(source.id, parsed.title, parsed.executeAt);
  var exist = await db.collection(C.notices).where({ dedupKey: key }).get();
  if (exist.data && exist.data.length) {
    return { deduped: true, id: exist.data[0]._id };
  }
  var res = await db.collection(C.notices).add({
    data: {
      dedupKey: key,
      sourceId: source.id,
      sourceName: source.name,
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
      source: { name: source.name, url: source.url, publishedAt: nowIso() },
      rawSnapshot: parsed.raw || '',
      createdAt: nowIso()
    }
  });
  return { deduped: false, id: res._id };
}

async function saveMarket(source, parsed) {
  var exist = await db.collection(C.markets).where({ symbol: parsed.symbol }).get();
  var doc = {
    symbol: parsed.symbol,
    name: parsed.name,
    code: parsed.symbol === 'wti' ? 'WTI CRUDE · USD / BBL' : 'BRENT CRUDE · USD / BBL',
    label: parsed.symbol === 'wti' ? 'WTI' : 'BRENT',
    price: parsed.price,
    changeAmount: parsed.changeAmount,
    changePercent: parsed.changePercent,
    open: parsed.open || parsed.price,
    prevClose: parsed.prevClose || parsed.price,
    high: parsed.high || parsed.price,
    low: parsed.low || parsed.price,
    quoteTime: parsed.quoteTime,
    delayed: !!parsed.delayed,
    delayMinutes: parsed.delayMinutes || 0,
    series: parsed.series || [],
    updatedAt: nowIso()
  };
  if (exist.data && exist.data.length) {
    await db.collection(C.markets).doc(exist.data[0]._id).update({ data: doc });
  } else {
    await db.collection(C.markets).add({ data: doc });
  }
}

/* ---------------- 地区油价采集（kind = price） ---------------- */

/** 读全部当前价，按 地区 → 油品 分组（新鲜度判断与涨跌计算都用它） */
async function loadPricesByRegion() {
  var res = await db.collection(C.prices).limit(1000).get();
  var map = {};
  (res.data || []).forEach(function (p) {
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
    var t = Date.parse(p.updatedAt || '');
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
      await saveRegionPrices(source, region, parsed);
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
async function saveRegionPrices(source, region, parsed) {
  var today = todayStr();
  for (var i = 0; i < shared.FUELS.length; i++) {
    var fuel = shared.FUELS[i];
    var price = parsed.prices[fuel.id];
    if (price === undefined) continue;
    var exist = await db.collection(C.prices).where({ regionCode: region.code, fuelId: fuel.id }).get();
    var old = exist.data && exist.data[0];
    var oldReal = old && old.source === source.id ? old : null;
    var changed = !oldReal || oldReal.price !== price;
    var doc = {
      regionCode: region.code,
      regionName: region.name + ' · ' + region.city,
      fuelId: fuel.id,
      fuelName: fuel.name,
      price: price,
      changeAmount: oldReal && changed ? shared.round2(price - oldReal.price) : (oldReal ? oldReal.changeAmount : 0),
      changeAt: oldReal && changed ? today : (oldReal ? oldReal.changeAt : ''),
      source: source.id,
      updatedAt: nowIso()
    };
    if (old) {
      await db.collection(C.prices).doc(old._id).update({ data: doc });
    } else {
      await db.collection(C.prices).add({ data: doc });
    }

    if (changed) {
      // 历史价按 (地区, 油品, 日期) 去重：同一天重复抓只更新价格
      var h = await db.collection(C.history).where({ regionCode: region.code, fuelId: fuel.id, date: today }).get();
      if (h.data && h.data.length) {
        await db.collection(C.history).doc(h.data[0]._id).update({ data: { price: price, source: source.id } });
      } else {
        await db.collection(C.history).add({
          data: { regionCode: region.code, fuelId: fuel.id, date: today, price: price, source: source.id }
        });
      }
    }
  }
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
    cycleStart: '',
    forecast: forecast,
    // 幅度解析不出来时 forecast 是空对象，方向单独存 ——
    // 前端据此显示「预计上调 · 幅度待公布」，而不是把未知当成持平 0
    forecastDirection: trend.direction,
    isOfficial: false,
    basis: basis,
    source: source.id,
    updatedAt: nowIso()
  };
  var exist = await db.collection(C.windows).where({ source: source.id, date: trend.date }).get();
  if (exist.data && exist.data.length) {
    var old = exist.data[0];
    if (JSON.stringify(old.forecast) === JSON.stringify(forecast) && old.basis === basis) {
      return { deduped: true, date: trend.date };
    }
    await db.collection(C.windows).doc(old._id).update({ data: doc });
  } else {
    await db.collection(C.windows).add({ data: doc });
  }
  return { deduped: false, date: trend.date };
}

/* ---------------- 演示数据写入（打通云端链路用） ---------------- */

async function seed(event) {
  // 误触发 seed 会清库。必须显式确认，而且只清演示数据，
  // 不碰采集器写进来的真实数据。
  if (!event || event.confirm !== 'seed') {
    return { ok: false, message: 'seed 需要显式确认：传 {"action":"seed","confirm":"seed"}' };
  }
  var today = todayStr();

  // 当前价
  var priceDocs = shared.allPrices().map(function (p) {
    return {
      regionCode: p.regionCode,
      regionName: p.regionName,
      fuelId: p.fuelId,
      fuelName: p.fuelName,
      price: p.price,
      changeAmount: p.changeAmount,
      changeAt: p.changeAt,
      source: 'seed',
      updatedAt: nowIso()
    };
  });
  await db.collection(C.prices).where({ source: 'seed' }).remove({});
  await db.collection(C.prices).add({ data: priceDocs });

  // 历史价：按调价节点回推
  var historyDocs = [];
  shared.REGIONS.forEach(function (region) {
    shared.FUELS.forEach(function (fuel) {
      var list = shared.levels(fuel.id);
      list.forEach(function (level) {
        if (!level.date) return;
        historyDocs.push({
          regionCode: region.code,
          fuelId: fuel.id,
          date: level.date,
          price: shared.round2(level.price + region.offset),
          source: 'seed'
        });
      });
    });
  });
  await db.collection(C.history).where({ source: 'seed' }).remove({});
  for (var i = 0; i < historyDocs.length; i += 20) {
    await db.collection(C.history).add({ data: historyDocs.slice(i, i + 20) });
  }

  // 调价节点
  var eventDocs = shared.ADJUSTMENTS.map(function (e) {
    return { date: e.date, title: e.title, deltas: e.deltas, official: true, source: 'seed' };
  });
  await db.collection(C.events).where({ source: 'seed' }).remove({});
  await db.collection(C.events).add({ data: eventDocs });

  // 通知
  var noticeDocs = shared.ADJUSTMENTS.slice().reverse().map(function (e) {
    var key = shared.dedupKey('seed', e.title, e.date);
    return {
      dedupKey: key,
      sourceId: 'seed',
      sourceName: '国家发展改革委价格监测中心（演示）',
      kind: 'official',
      title: e.title,
      publishedAt: e.date + 'T18:00:00+08:00',
      executeAt: e.date + 'T24:00:00+08:00',
      changes: e.deltas,
      reviewStatus: 'approved',
      summary: '演示数据：正式版本展示发布机构、发布时间与原文链接。',
      prices: {},
      source: { name: '国家发展改革委价格监测中心（演示）', url: '', publishedAt: e.date + 'T18:00:00+08:00' },
      rawSnapshot: '',
      createdAt: nowIso()
    };
  });
  await db.collection(C.notices).where({ sourceId: 'seed' }).remove({});
  await db.collection(C.notices).add({ data: noticeDocs });

  // 调价窗口
  await db.collection(C.windows).where({ source: 'seed' }).remove({});
  await db.collection(C.windows).add({
    data: {
      date: today,
      time: '24:00',
      cycleStart: today,
      forecast: { '92': -0.12, '95': -0.13, '98': -0.14, '0': -0.11 },
      isOfficial: false,
      basis: '演示窗口数据',
      source: 'seed',
      updatedAt: nowIso()
    }
  });

  // 国际行情：用与演示源同一份实现生成，
  // 之前 seed 写的是空 series，云端模式下国际行情图整个是空的。
  await db.collection(C.markets).where({ source: 'seed' }).remove({});
  var marketDocs = ['brent', 'wti'].map(function (symbol) {
    var m = shared.buildMarketPayload(symbol, '1d');
    return {
      symbol: m.symbol,
      name: m.name,
      code: m.code,
      label: m.label,
      price: m.price,
      changeAmount: m.changeAmount,
      changePercent: m.changePercent,
      open: m.open,
      prevClose: m.prevClose,
      high: m.high,
      low: m.low,
      quoteTime: m.quoteTime,
      delayed: m.delayed,
      delayMinutes: m.delayMinutes,
      series: m.points,
      source: 'seed',
      updatedAt: nowIso()
    };
  });
  for (var mi = 0; mi < marketDocs.length; mi++) {
    await db.collection(C.markets).add({ data: marketDocs[mi] });
  }

  return { ok: true, data: { seeded: true, prices: priceDocs.length, history: historyDocs.length } };
}

/* ---------------- 主流程 ---------------- */

async function collect(options) {
  var startedAt = nowIso();
  var results = [];
  var needsReview = [];

  for (var i = 0; i < sources.SOURCES.length; i++) {
    var result = await collectFromSource(sources.SOURCES[i], options);
    results.push(result);
    if (result.status === 'needsReview' || result.status === 'failed') {
      needsReview.push({
        sourceId: result.sourceId,
        reason: result.reason,
        message: result.message,
        at: nowIso()
      });
    }
  }

  // 真实来源一个都没启用时，状态是 idle —— 不能报「同步正常」，
  // 否则前端会让人以为后台在真实采集。
  var allSkipped = results.length > 0 && results.every(function (r) { return r.status === 'skipped'; });
  var run = {
    startedAt: startedAt,
    finishedAt: nowIso(),
    status: allSkipped ? 'idle' : (needsReview.length ? 'partial' : 'ok'),
    sourceName: '服务端定时采集',
    results: results,
    needsReview: needsReview
  };
  await db.collection(C.runs).add({ data: run });

  return { ok: true, data: run };
}

exports.main = async (event) => {
  var action = (event && event.action) || 'collect';
  try {
    if (action === 'seed') {
      var seedResult = await seed(event);
      return { ok: true, data: seedResult.data };
    }
    var result = await collect(event);
    return { ok: true, data: result.data };
  } catch (err) {
    console.error('[oilCollector] failed', err);
    await db.collection(C.runs).add({
      data: {
        startedAt: nowIso(),
        finishedAt: nowIso(),
        status: 'error',
        sourceName: '服务端定时采集',
        results: [],
        needsReview: [{ sourceId: '-', reason: 'INTERNAL_ERROR', message: (err && err.errMsg) || String(err), at: nowIso() }]
      }
    });
    return { ok: false, message: (err && err.errMsg) || String(err), code: 'INTERNAL_ERROR' };
  }
};
