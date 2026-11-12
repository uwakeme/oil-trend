/**
 * 查询类业务
 *
 * ⚠️ 返回结构必须与小程序端的期望完全一致 ——
 * 小程序端 utils/api.js 的 hasExpected() 会检查必需字段，
 * 结构对不上就会静默回落到演示数据，页面看着正常但实际没走服务端。
 *
 * 查询逻辑与早期云函数实现一致（云函数已下线，见 git 历史），算法部分没改。
 */
const dao = require('../dao');
const shared = require('../shared/shared');

/* ---------------- 时间辅助 ---------------- */

function todayStr() {
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

function dayDiff(fromDate, toDate) {
  var a = new Date(fromDate + 'T00:00:00Z').getTime();
  var b = new Date(toDate + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/* ---------------- 公共读取 ---------------- */

function getPrices(regionCode) {
  return dao.prices.listByRegion(regionCode);
}

function getWindow() {
  return dao.windows.latest();
}

function getLatestNotice() {
  return dao.notices.latestOfficial();
}

function getAdjustEvents() {
  return dao.events.listAll();
}

/**
 * 一次取回某个地区全部油品的历史价，按油品分组。
 * 之前每个油品查一次，4 个油品就是 4 次串行查询。
 */
function getHistoryByRegion(regionCode, fromDate) {
  return dao.history.listByRegion(regionCode, fromDate).then(function (all) {
    var byFuel = {};
    all.forEach(function (h) {
      if (!byFuel[h.fuelId]) byFuel[h.fuelId] = [];
      byFuel[h.fuelId].push(h);
    });
    return byFuel;
  });
}

function buildWindow(windowDoc) {
  if (!windowDoc) {
    return {
      date: todayStr(),
      time: '24:00',
      daysLeft: 0,
      isOfficial: false,
      basis: '暂无窗口数据',
      forecast: {}
    };
  }
  var daysLeft = dayDiff(todayStr(), windowDoc.date);
  var totalDays = Math.max(1, dayDiff(windowDoc.cycleStart || windowDoc.date, windowDoc.date));
  var passedDays = Math.max(0, totalDays - daysLeft);
  return {
    date: windowDoc.date,
    time: windowDoc.time || '24:00',
    daysLeft: daysLeft,
    cycleStart: windowDoc.cycleStart,
    cycleStarted: passedDays > 0,
    progress: Math.min(100, Math.max(0, Math.round(passedDays / totalDays * 100))),
    isOfficial: !!windowDoc.isOfficial,
    basis: windowDoc.basis || '',
    forecast: windowDoc.forecast || {},
    // 幅度可能解析不出来（forecast 为空对象），方向单独给 ——
    // 前端靠它区分「持平」和「有方向但幅度待公布」
    forecastDirection: windowDoc.forecastDirection || ''
  };
}

/* ---------------- 地区列表 ---------------- */

function actionRegions() {
  return Promise.all([getPrices(shared.DEFAULT_REGION_CODE), dao.prices.listAll()]).then(function (all) {
    var allPrices = all[1];
    var map = {};
    allPrices.forEach(function (p) {
      if (p.fuelId === '92') map[p.regionCode] = p;
    });
    var regions = shared.REGIONS.map(function (r) {
      var p = map[r.code];
      return {
        code: r.code,
        name: r.name,
        city: r.city,
        fullName: r.name + ' · ' + r.city,
        price92: p ? p.price : null
      };
    });
    return { regions: regions };
  });
}

/* ---------------- 首页 ---------------- */

function actionHome(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var region = shared.regionByCode(regionCode);

  return Promise.all([
    getPrices(regionCode),
    getWindow(),
    getLatestNotice()
  ]).then(function (r0) {
    var prices = r0[0];
    var win = r0[1];
    var notice = r0[2];

    var priceList = prices.map(function (p) {
      return {
        id: p.fuelId,
        name: p.fuelName,
        short: p.fuelId + '#',
        unit: '元/升',
        price: p.price,
        changeAmount: p.changeAmount || 0,
        changeAt: p.changeAt || '',
        direction: (p.changeAmount || 0) < 0 ? 'down' : ((p.changeAmount || 0) > 0 ? 'up' : 'flat')
      };
    });
    priceList.sort(function (a, b) {
      return shared.FUELS.findIndex(function (f) { return f.id === a.id; }) -
        shared.FUELS.findIndex(function (f) { return f.id === b.id; });
    });

    var today = todayStr();
    var from30 = new Date(new Date(today + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);

    var labels = [
      from30.slice(5).replace('-', '月') + '日',
      new Date(new Date(today + 'T00:00:00Z').getTime() - 14 * 86400000).toISOString().slice(0, 10).slice(5).replace('-', '月') + '日',
      today.slice(5).replace('-', '月') + '日'
    ];

    return getHistoryByRegion(regionCode, from30).then(function (historyByFuel) {
      var trend30 = {};
      for (var i = 0; i < shared.FUELS.length; i++) {
        var f = shared.FUELS[i];
        var fh = historyByFuel[f.id] || [];
        trend30[f.id] = {
          points: fh.filter(function (h) { return h.date >= from30; }).map(function (h) {
            return { date: h.date, value: h.price };
          }),
          labels: labels
        };
      }

      var changes = {};
      if (notice && notice.changes) {
        shared.FUELS.forEach(function (f) { changes[f.id] = notice.changes[f.id]; });
      }

      return {
        region: { code: region.code, fullName: region.name + ' · ' + region.city },
        prices: priceList,
        window: buildWindow(win),
        trend30: trend30,
        changes: changes,
        notice: notice ? {
          id: notice.id,
          kind: notice.kind,
          title: notice.title,
          publishedAt: notice.publishedAt,
          executeAt: notice.executeAt,
          changes: notice.changes || {},
          summary: notice.summary || '',
          source: notice.source || {}
        } : null,
        publishedAt: notice ? notice.publishedAt : '',
        source: { mode: 'server', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
      };
    });
  });
}

/* ---------------- 走势 ---------------- */

function actionTrend(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var fuelId = payload.fuelId || '92';
  var period = payload.period || '3m';
  var months = { '3m': 3, '6m': 6, '1y': 12 }[period] || 3;
  var region = shared.regionByCode(regionCode);

  var today = todayStr();
  var fromDate = new Date(new Date(today + 'T00:00:00Z').getTime() - months * 30 * 86400000).toISOString().slice(0, 10);

  return Promise.all([
    dao.history.listByRegionFuel(regionCode, fuelId, fromDate),
    getAdjustEvents(),
    getPrices(regionCode)
  ]).then(function (r0) {
    var history = r0[0];
    var allEvents = r0[1];
    var prices = r0[2];

    var events = allEvents.filter(function (e) {
      return e.date >= fromDate && e.date <= today;
    });

    var values = history.map(function (h) { return h.price; });
    if (!values.length) {
      var err = new Error('该区间暂无历史数据');
      err.code = 'NO_HISTORY';
      throw err;
    }
    var first = values[0];
    var last = values[values.length - 1];
    var deltaPercent = first ? Number((((last - first) / first) * 100).toFixed(2)) : 0;

    var points = history.map(function (h) { return { date: h.date, value: h.price }; });

    var priceMap = {};
    prices.forEach(function (p) { priceMap[p.fuelId] = p.price; });

    // 调价当天的价格：历史节点不能都显示当前价，否则一屏节点看着像同一条
    var priceByDate = {};
    history.forEach(function (h) { priceByDate[h.date] = h.price; });

    return {
      region: { code: region.code, fullName: region.name + ' · ' + region.city },
      fuel: { id: fuelId, name: (shared.FUELS.filter(function (f) { return f.id === fuelId; })[0] || {}).name || fuelId },
      price: last,
      deltaPercent: deltaPercent,
      direction: deltaPercent > 0 ? 'up' : (deltaPercent < 0 ? 'down' : 'flat'),
      rangeLabel: { '3m': '近 3 个月', '6m': '近 6 个月', '1y': '近 1 年' }[period],
      low: Math.min.apply(null, values),
      high: Math.max.apply(null, values),
      count: events.length,
      axis: [
        fromDate.slice(0, 7).replace('-', '/'),
        new Date(new Date(fromDate + 'T00:00:00Z').getTime() + Math.floor((months * 30 * 86400000) / 2)).toISOString().slice(0, 7).replace('-', '/'),
        today.slice(0, 7).replace('-', '/')
      ],
      points: points,
      events: events.map(function (e) {
        return {
          date: e.date,
          title: e.title,
          amount: (e.deltas || {})[fuelId] || 0,
          direction: ((e.deltas || {})[fuelId] || 0) < 0 ? 'down' : 'up',
          priceAfter: priceByDate[e.date] !== undefined ? priceByDate[e.date] : priceMap[fuelId]
        };
      }),
      source: { mode: 'server', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
    };
  });
}

module.exports = {
  actionRegions: actionRegions,
  actionHome: actionHome,
  actionTrend: actionTrend,
  getPrices: getPrices,
  getWindow: getWindow,
  getLatestNotice: getLatestNotice,
  getAdjustEvents: getAdjustEvents,
  getHistoryByRegion: getHistoryByRegion,
  buildWindow: buildWindow,
  todayStr: todayStr
};
