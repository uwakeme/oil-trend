/**
 * 调价通知、国际行情、同步状态
 *
 * 逻辑与早期云函数实现一致（云函数已下线，见 git 历史）。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const query = require('./query');

/* ---------------- 调价通知 ---------------- */

var NOTICE_PAGE = 20;

/**
 * 通知详情里的「调整后零售价」。
 *
 * 采集入库时不存这张表（各地挂牌价是采集来的，公告里并没有写），
 * 这里只在「公告已生效」时用当前价倒推：
 *   after  = 当前挂牌价（已经包含这次调整）
 *   before = after - 本次调整幅度
 * 还没生效的公告不倒推 —— 那时当前价里还没有这次调整，倒推出来是错的。
 * 倒推不出来就留空，界面显示「暂无价格」，不编数字。
 */
function noticePricesOf(notice, priceMap, today) {
  if (notice.prices && Object.keys(notice.prices).length) return notice.prices;
  if (notice.kind !== 'official') return {};
  var executeAt = String(notice.executeAt || '').slice(0, 10);
  if (!executeAt || executeAt > today) return {};
  var out = {};
  Object.keys(priceMap).forEach(function (fuelId) {
    var delta = (notice.changes || {})[fuelId];
    if (typeof delta !== 'number') return;
    var after = Number(priceMap[fuelId]);
    if (!isFinite(after)) return;
    out[fuelId] = {
      before: Math.round((after - delta) * 100) / 100,
      after: after,
      delta: delta
    };
  });
  return out;
}

function actionNotices(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var filter = payload.filter || 'official';
  var skip = Number(payload.skip) || 0;
  var region = query.resolveRegion(regionCode);

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
    var today = query.todayStr();

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
          prices: noticePricesOf(n, priceMap, today),
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

/**
 * 延时分钟数。
 *
 * ⚠️ 后端原来不返回这个字段，前端直接拼「延时 undefined 分钟」。
 * 行情源给的 quoteTime 是报价时刻，延时 = 现在 - 报价时刻；
 * 算不出来就返回 null（界面显示「延时行情」，不显示 undefined）。
 */
function delayMinutesOf(doc) {
  if (!doc || !doc.delayed) return 0;
  var t = Date.parse(doc.quoteTime || '');
  if (!isFinite(t)) return null;
  var minutes = Math.round((Date.now() - t) / 60000);
  return minutes > 0 ? minutes : null;
}

/** 品种代码：BRENT / WTI */
function marketCode(symbol) {
  return symbol === 'wti' ? 'WTI' : 'BRENT';
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
        code: marketCode(symbol),
        price: fallback.price,
        changeAmount: fallback.changeAmount,
        changePercent: fallback.changePercent,
        direction: fallback.direction,
        open: fallback.open,
        prevClose: fallback.prevClose,
        high: fallback.high,
        low: fallback.low,
        points: fallback.points,
        axis: fallback.axis,
        delayed: fallback.delayed,
        delayMinutes: delayMinutesOf({ delayed: fallback.delayed, quoteTime: fallback.quoteTime }),
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

    var changeAmount = doc.changeAmount || 0;
    return {
      symbol: doc.symbol,
      name: doc.name || doc.symbol,
      code: marketCode(doc.symbol),
      price: doc.price,
      changeAmount: changeAmount,
      changePercent: doc.changePercent || 0,
      // direction 是前端 trend-chart 的必传属性（String），
      // 演示源 data/markets.js 也有，这里必须补上，否则前端拿到 null。
      // 三态：涨跌额为 0 是「持平」，不能染成上涨。
      direction: changeAmount < 0 ? 'down' : (changeAmount > 0 ? 'up' : 'flat'),
      open: doc.open,
      prevClose: doc.prevClose,
      high: doc.high,
      low: doc.low,
      points: points,
      axis: shared.marketAxisLabel(quoteTimeOf(sliced), period === '1d' ? 'time' : 'day'),
      delayed: !!doc.delayed,
      delayMinutes: delayMinutesOf(doc),
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
 * 早期是 actionHome 顺带返回的，这里拆成独立接口 ——
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
