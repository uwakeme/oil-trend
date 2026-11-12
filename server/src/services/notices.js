/**
 * 调价通知、国际行情、同步状态
 *
 * 与 cloudfunctions/oilApi/index.js 的 actionNotices / actionMarket 一致。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const query = require('./query');

/* ---------------- 调价通知 ---------------- */

var NOTICE_PAGE = 20;

function actionNotices(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var filter = payload.filter || 'official';
  var skip = Number(payload.skip) || 0;
  var region = shared.regionByCode(regionCode);

  return Promise.all([
    dao.notices.listPublic(filter, NOTICE_PAGE, skip),
    query.getWindow(),
    query.getPrices(regionCode),
    dao.runs.latest()
  ]).then(function (r0) {
    var notices = r0[0];
    var win = r0[1];
    var prices = r0[2];
    var lastRun = r0[3];

    var priceMap = {};
    prices.forEach(function (p) { priceMap[p.fuelId] = p.price; });

    return {
      region: { code: region.code, fullName: region.name + ' · ' + region.city },
      window: query.buildWindow(win),
      sync: {
        // 没有采集记录 / 真实来源全关时是 idle，不能报「同步正常」
        status: lastRun ? (lastRun.needsReview && lastRun.needsReview.length ? 'pending' : (lastRun.status || 'idle')) : 'idle',
        lastCheckedAt: lastRun ? lastRun.finishedAt : '',
        sourceName: lastRun ? lastRun.sourceName : '服务端定时采集',
        sourceUrl: ''
      },
      notices: notices.map(function (n) {
        return {
          id: n.id,
          kind: n.kind,
          title: n.title,
          publishedAt: n.publishedAt,
          executeAt: n.executeAt,
          changes: n.changes || {},
          summary: n.summary || '',
          prices: n.prices || {},
          source: n.source || {}
        };
      }),
      source: { mode: 'server', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
    };
  });
}

/* ---------------- 国际行情 ---------------- */

/** 行情周期对应的天数跨度 */
var MARKET_PERIOD_DAYS = { '1d': 1, '1w': 7, '1m': 30, '3m': 90 };

/** 'YYYY-MM-DD HH:mm:ss' → 时间戳；解析不出来返回 null */
function seriesTime(dateStr) {
  var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * 按周期裁剪曲线。
 * 之前 payload.period 只是原样回显，切 1日/1周/1月/3月 拿到的永远是同一条线。
 */
function sliceSeries(series, period) {
  var list = series || [];
  if (!list.length) return [];
  var days = MARKET_PERIOD_DAYS[period] || 1;
  var times = list.map(seriesTime);
  var last = null;
  for (var i = times.length - 1; i >= 0; i--) {
    if (times[i] !== null) { last = times[i]; break; }
  }
  if (last === null) return list.slice(-1);
  var from = last - days * 86400000;
  var out = [];
  for (var j = 0; j < list.length; j++) {
    if (times[j] === null || times[j] >= from) out.push(list[j]);
  }
  return out.length ? out : list.slice(-1);
}

function actionMarket(payload) {
  var symbol = payload.symbol === 'wti' ? 'wti' : 'brent';
  var period = payload.period || '1d';

  return dao.markets.findBySymbol(symbol).then(function (doc) {
    if (!doc) {
      // 库里还没有这个品种：回落到共享模块生成的演示载荷，
      // 保证接口结构完整（前端会检查 price / points 字段）
      var fallback = shared.buildMarketPayload(symbol, period);
      return {
        symbol: fallback.symbol,
        name: fallback.name,
        price: fallback.price,
        changeAmount: fallback.changeAmount,
        changePercent: fallback.changePercent,
        open: fallback.open,
        prevClose: fallback.prevClose,
        high: fallback.high,
        low: fallback.low,
        points: fallback.points,
        axis: fallback.axis,
        delayed: fallback.delayed,
        quoteTime: fallback.quoteTime,
        // mode 必须标 demo：前端靠它判断该不该显示「（演示数据）」，
        // 以及该不该把延迟状态写成「实时」。
        source: { mode: 'demo', name: '服务端定时采集', note: '演示数据（尚未采集真实行情）' }
      };
    }

    // 库里存的是 points 数组（{date, value}），不是 {date, price}
    var series = doc.series || [];
    var sliced = sliceSeries(series, period);
    var points = sliced.map(function (p) {
      return { date: p.date, value: p.value !== undefined ? p.value : p.price };
    });

    return {
      symbol: doc.symbol,
      name: doc.name || doc.symbol,
      price: doc.price,
      changeAmount: doc.changeAmount || 0,
      changePercent: doc.changePercent || 0,
      open: doc.open,
      prevClose: doc.prevClose,
      high: doc.high,
      low: doc.low,
      points: points,
      axis: shared.marketAxisLabel(quoteTimeOf(sliced), period === '1d' ? 'time' : 'day'),
      delayed: !!doc.delayed,
      quoteTime: doc.quoteTime || '',
      source: { mode: 'server', name: '服务端定时采集', note: '数据来自服务端采集的国际行情' }
    };
  });
}

function quoteTimeOf(sliced) {
  if (!sliced.length) return '';
  var last = sliced[sliced.length - 1];
  return last.date || '';
}

/* ---------------- 同步状态 ---------------- */

/**
 * 采集同步状态。
 * 云函数里这个是 actionHome 顺带返回的，拆成独立接口 ——
 * 它只被调价页用，不必混进首页响应。
 */
function actionSyncStatus() {
  return dao.runs.latest().then(function (lastRun) {
    if (!lastRun) {
      return {
        status: 'idle',
        sourceName: '服务端定时采集',
        lastCheckedAt: '',
        needsReview: [],
        source: { mode: 'server', name: '服务端定时采集', note: '真实数据源尚未接入' }
      };
    }
    return {
      status: (lastRun.needsReview && lastRun.needsReview.length) ? 'pending' : (lastRun.status || 'idle'),
      sourceName: lastRun.sourceName || '服务端定时采集',
      lastCheckedAt: lastRun.finishedAt || '',
      needsReview: lastRun.needsReview || [],
      source: { mode: 'server', name: lastRun.sourceName || '服务端定时采集', note: '数据来自服务端采集的官方公告' }
    };
  });
}

module.exports = {
  actionNotices: actionNotices,
  actionMarket: actionMarket,
  actionSyncStatus: actionSyncStatus,
  sliceSeries: sliceSeries,
  seriesTime: seriesTime
};
