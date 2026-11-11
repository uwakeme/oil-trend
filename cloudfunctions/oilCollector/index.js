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
 *   - 手动调用 event.action = 'seed'   写入演示数据（用于打通云端链路）
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
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
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

async function collectFromSource(source) {
  if (!source.enabled) {
    return { sourceId: source.id, status: 'skipped', reason: 'SOURCE_DISABLED', message: '来源未启用' };
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

async function collect() {
  var startedAt = nowIso();
  var results = [];
  var needsReview = [];

  for (var i = 0; i < sources.SOURCES.length; i++) {
    var result = await collectFromSource(sources.SOURCES[i]);
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
    var result = await collect();
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
