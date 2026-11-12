/**
 * 本地演示数据源（默认数据源）
 *
 * 它是「真实数据源适配层」的标准实现形态：对外暴露与云函数完全一致的
 * 数据结构。接入真实接口时，只要在 utils/api.js 里换掉取数逻辑，
 * 页面代码一行都不用改。
 *
 * 计算规则：
 *   某地某油品当前价 = 全国价(累加所有调价幅度) + 地区价差
 */
const { ADJUSTMENTS, NATIONAL_BASE } = require('./adjustments');
const { REGIONS, DEFAULT_REGION_CODE } = require('./regions');
const { FUELS, getFuel } = require('./fuels');
const { ADJUST_WINDOW, NOTICES, SYNC_STATUS } = require('./notices');
const { buildMarketPayload } = require('./markets');
const clock = require('../utils/demo-clock');

function round2(v) {
  return Math.round(v * 100) / 100;
}

/* ---------- 全国价格阶梯 ---------- */

var LEVEL_CACHE = {};

function levels(fuelId) {
  if (LEVEL_CACHE[fuelId]) return LEVEL_CACHE[fuelId];
  var price = NATIONAL_BASE[fuelId];
  var list = [{ date: null, price: price, delta: 0, title: null }];
  ADJUSTMENTS.forEach(function (item) {
    price = round2(price + item.deltas[fuelId]);
    list.push({
      // 调价节点要和区间起点、窗口日期用同一个时间基准，
      // 否则平移一两周后「已平移的区间」和「未平移的节点」就对不上了，
      // 调价次数会一路掉到 0。
      date: clock.shiftDate(item.date),
      price: price,
      delta: item.deltas[fuelId],
      title: item.title
    });
  });
  LEVEL_CACHE[fuelId] = list;
  return list;
}

/** 某个日期当时生效的全国价 */
function nationalPriceOn(fuelId, dateStr) {
  var list = levels(fuelId);
  var price = list[0].price;
  for (var i = 1; i < list.length; i++) {
    if (list[i].date <= dateStr) price = list[i].price;
    else break;
  }
  return price;
}

function regionByCode(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i].code === code) return REGIONS[i];
  }
  return REGIONS[0];
}

/**
 * 某地某油品在某天的零售价
 *
 * ⚠️ 地区价差按油品分别取：现实中各省的标号结构不同
 * （98# 相对 92# 的溢价各省差 1.3 元/升），共用一套 offset 误差太大。
 */
function priceOn(regionCode, fuelId, dateStr) {
  var region = regionByCode(regionCode);
  var offset = (region.offset && region.offset[fuelId] !== undefined) ? region.offset[fuelId] : 0;
  return round2(nationalPriceOn(fuelId, dateStr) + offset);
}

function currentPrice(regionCode, fuelId) {
  return priceOn(regionCode, fuelId, clock.today());
}

/** 最近一次调价 */
function lastAdjustment(fuelId) {
  var list = levels(fuelId);
  return list[list.length - 1];
}

/* ---------- 对外接口 ---------- */

function getRegions() {
  return REGIONS.map(function (region) {
    return {
      code: region.code,
      name: region.name,
      city: region.city,
      fullName: region.name + ' · ' + region.city,
      price92: currentPrice(region.code, '92')
    };
  });
}

function windowPayload(fuelId) {
  var windowDate = clock.shiftDate(ADJUST_WINDOW.date);
  var cycleStart = clock.shiftDate(ADJUST_WINDOW.cycleStartDate);
  var forecast = ADJUST_WINDOW.forecast[fuelId];

  // 天数计算全部基于平移后的日期，和界面显示的日期保持一致。
  // 之前用未平移的原始日期算，会和显示差一天；进度还会恒为 0 后突然跳 100%。
  var daysLeft = clock.daysUntil(windowDate);
  var totalDays = Math.max(1, daysLeft - clock.daysUntil(cycleStart));
  var passedDays = Math.max(0, totalDays - daysLeft);
  var progress = Math.min(100, Math.max(0, Math.round(passedDays / totalDays * 100)));

  return {
    date: windowDate,
    time: ADJUST_WINDOW.time,
    daysLeft: daysLeft,
    cycleStart: cycleStart,
    cycleStarted: progress > 0,
    progress: progress,
    forecastAmount: forecast,
    forecast: ADJUST_WINDOW.forecast,
    direction: forecast < 0 ? 'down' : 'up',
    isOfficial: ADJUST_WINDOW.isOfficial,
    basis: ADJUST_WINDOW.basis
  };
}

/** 某油品最近 n 天的每日价格（阶梯形态，真实反映"价格只在调价日变化"） */
function dailySeries(regionCode, fuelId, days) {
  var today = clock.today();
  var out = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = clock.daysAgo(i, today);
    out.push({ date: d, value: priceOn(regionCode, fuelId, d) });
  }
  return out;
}

/** 区间内的调价节点与价格阶梯 */
function periodLevels(regionCode, fuelId, fromDate) {
  var region = regionByCode(regionCode);
  var list = levels(fuelId);
  var events = [];
  var points = [];

  // 地区价差按油品分别取（各省标号结构不同，不能共用一套）
  var offset = (region.offset && region.offset[fuelId] !== undefined) ? region.offset[fuelId] : 0;

  // 区间起点时生效的价格
  var basePrice = nationalPriceOn(fuelId, fromDate);
  points.push({ date: fromDate, value: round2(basePrice + offset) });

  for (var i = 1; i < list.length; i++) {
    var item = list[i];
    if (item.date <= fromDate) continue;
    if (item.date > clock.today()) break;
    events.push({
      date: item.date,
      title: item.title,
      amount: item.delta,
      direction: item.delta < 0 ? 'down' : 'up',
      priceAfter: round2(item.price + offset)
    });
    points.push({ date: item.date, value: round2(item.price + offset) });
  }
  return { points: points, events: events };
}

function getHome(regionCode, fuelId) {
  var region = regionByCode(regionCode || DEFAULT_REGION_CODE);
  var today = clock.today();

  var prices = FUELS.map(function (f) {
    var change = lastAdjustment(f.id);
    return {
      id: f.id,
      name: f.name,
      short: f.short,
      unit: f.unit,
      price: currentPrice(region.code, f.id),
      changeAmount: change.delta,
      changeAt: change.date,
      direction: change.delta < 0 ? 'down' : (change.delta > 0 ? 'up' : 'flat')
    };
  });

  // 四个油品的迷你走势一次算好，切换油品时不必重新取数
  // daysAgo / today 返回的已经是平移后的日期，别再平移一次
  var labels = [
    clock.daysAgo(29).slice(5).replace('-', '月') + '日',
    clock.daysAgo(15).slice(5).replace('-', '月') + '日',
    today.slice(5).replace('-', '月') + '日'
  ];
  var trend30 = {};
  FUELS.forEach(function (f) {
    trend30[f.id] = { points: dailySeries(region.code, f.id, 30), labels: labels };
  });

  var latestNotice = NOTICES.filter(function (n) { return n.kind === 'official'; })[0];
  var noticeChanges = {};
  FUELS.forEach(function (f) { noticeChanges[f.id] = latestNotice.changes[f.id]; });

  return {
    region: {
      code: region.code,
      name: region.name,
      city: region.city,
      fullName: region.name + ' · ' + region.city
    },
    prices: prices,
    updatedAt: clock.todayUpdatedAt(),
    window: windowPayload(fuelId || '92'),
    trend30: trend30,
    latestNotice: {
      id: latestNotice.id,
      title: latestNotice.title,
      executeAt: clock.shiftDateTime(latestNotice.executeAt),
      changes: noticeChanges
    },
    source: {
      mode: 'demo',
      name: '内置演示数据集',
      note: '演示数据，非真实行情'
    }
  };
}

var PERIODS = {
  '3m': { months: 3, label: '近 3 个月' },
  '6m': { months: 6, label: '近 6 个月' },
  '1y': { months: 12, label: '近 1 年' }
};

function getTrend(regionCode, fuelId, period) {
  var region = regionByCode(regionCode || DEFAULT_REGION_CODE);
  var fuel = getFuel(fuelId);
  var conf = PERIODS[period] || PERIODS['3m'];
  var from = clock.monthsAgo(conf.months);

  var data = periodLevels(region.code, fuel.id, from);
  var values = data.points.map(function (p) { return p.value; });
  var first = values[0];
  var last = values[values.length - 1];
  var deltaPct = first ? ((last - first) / first) * 100 : 0;

  var axis = [
    from.slice(0, 7).replace('-', '/'),
    clock.monthsAgo(Math.round(conf.months / 2)).slice(0, 7).replace('-', '/'),
    clock.today().slice(0, 7).replace('-', '/')
  ];

  return {
    region: { code: region.code, fullName: region.name + ' · ' + region.city },
    fuel: { id: fuel.id, name: fuel.name, short: fuel.short },
    price: last,
    deltaPercent: Number(deltaPct.toFixed(2)),
    direction: deltaPct > 0 ? 'up' : (deltaPct < 0 ? 'down' : 'flat'),
    rangeLabel: conf.label,
    low: Math.min.apply(null, values),
    high: Math.max.apply(null, values),
    count: data.events.length,
    axis: axis,
    points: data.points,
    events: data.events,
    source: { mode: 'demo', name: '内置演示数据集', note: '演示数据，非真实行情' }
  };
}

function getNotices(regionCode, filter, fuelId) {
  var region = regionByCode(regionCode || DEFAULT_REGION_CODE);
  var fuel = getFuel(fuelId || '92');
  var list = NOTICES.map(function (n) {
    var changes = {};
    FUELS.forEach(function (f) { changes[f.id] = n.changes[f.id]; });
    return {
      id: n.id,
      kind: n.kind,
      title: n.title,
      publishedAt: clock.shiftDateTime(n.publishedAt),
      executeAt: clock.shiftDateTime(n.executeAt),
      changes: changes,
      summary: n.summary,
      prices: buildPricesFor(region, n),
      source: {
        name: n.source.name,
        url: n.source.url,
        publishedAt: clock.shiftDateTime(n.source.publishedAt)
      }
    };
  });

  var result = list;
  if (filter === 'official' || filter === 'forecast') {
    result = list.filter(function (n) { return n.kind === filter; });
  }

  return {
    region: { code: region.code, fullName: region.name + ' · ' + region.city },
    window: windowPayload(fuel.id),
    sync: {
      status: SYNC_STATUS.status,
      lastCheckedAt: clock.shiftDateTime(SYNC_STATUS.lastCheckedAt),
      sourceName: SYNC_STATUS.sourceName,
      sourceUrl: SYNC_STATUS.sourceUrl
    },
    notices: result,
    source: { mode: 'demo', name: '内置演示数据集', note: '演示数据，非真实行情' }
  };
}

function buildPricesFor(region, notice) {
  var out = {};
  // 用「这次调价执行当天之后的价格」，不能用当前价 ——
  // 否则每条历史通知显示的都是今天的价格，看着像同一条通知
  var executeDate = String(notice.executeAt || '').slice(0, 10);
  FUELS.forEach(function (f) {
    var delta = notice.changes[f.id];
    var after = priceOn(region.code, f.id, executeDate);
    out[f.id] = {
      before: round2(after - delta),
      after: after,
      delta: delta
    };
  });
  return out;
}

/**
 * 国际行情。
 *
 * 载荷由 data/markets.js 的 buildMarketPayload 生成 —— 云函数端用的是同一份
 * 实现（由 scripts/sync-cloud-shared.js 从 data/ 内联过去），两端不会再分叉。
 */
function getMarket(symbol, period) {
  var payload = buildMarketPayload(symbol, period);
  payload.source = { mode: 'demo', name: '内置演示数据集', note: '演示数据，非真实行情' };
  return payload;
}

function getAlertHistory() {
  return [
    {
      id: 'history-1',
      title: '92# 汽油官方降价',
      time: clock.shiftDate('2026-11-02') + ' 20:03',
      channel: '订阅消息',
      priceText: '7.36'
    },
    {
      id: 'history-2',
      title: '已达目标价 7.40',
      time: clock.shiftDate('2026-09-28') + ' 20:06',
      channel: '订阅消息',
      priceText: '7.38'
    }
  ];
}

module.exports = {
  getRegions: getRegions,
  getAlertHistory: getAlertHistory,
  getHome: getHome,
  getTrend: getTrend,
  getNotices: getNotices,
  getMarket: getMarket,
  currentPrice: currentPrice,
  priceOn: priceOn
};
