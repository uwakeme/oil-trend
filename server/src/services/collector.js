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
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
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

/* ---------------- 主流程 ---------------- */

function collectFromSource(source) {
  if (!source.enabled) {
    return Promise.resolve({ sourceId: source.id, status: 'skipped', reason: 'SOURCE_DISABLED', message: '来源未启用' });
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

function run() {
  var startedAt = nowIso();
  var results = [];
  var needsReview = [];

  return sources.SOURCES.reduce(function (chain, source) {
    return chain.then(function () {
      return collectFromSource(source).then(function (result) {
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
