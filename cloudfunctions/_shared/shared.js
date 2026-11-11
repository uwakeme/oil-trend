/**
 * 云函数共享模块 —— 由 scripts/sync-cloud-shared.js 自动生成，请勿手改。
 *
 * 数据真源在小程序端 data/ 下：
 *   data/adjustments.js  调价时间线（全国统一幅度）
 *   data/regions.js      地区价差
 *   data/fuels.js        油品定义
 *
 * 改了上面任意一个文件，都要重新跑 scripts/sync-cloud-shared.js。
 */

/* ---------- 行情（来自 data/markets.js，两端共用同一份实现） ---------- */

/**
 * 国际原油行情（演示数据）
 *
 * 说明：国际原油与国内成品油不是一个东西，价格受税费、定价周期、
 * 汇率等因素影响，只作为市场参考。单位统一为 美元/桶。
 */
const MARKETS = {
  brent: {
    symbol: 'brent',
    name: '布伦特原油',
    code: 'BRENT CRUDE · USD / BBL',
    label: '布伦特',
    price: 78.42,
    prevClose: 77.78,
    open: 77.81,
    high: 78.67,
    low: 77.56,
    changeAmount: 0.64,
    changePercent: 0.82,
    // 行情时间相对「现在」往前推，延时行情必须如实标注
    quoteMinutesAgo: 12,
    delayed: true,
    seed: 20261110
  },
  wti: {
    symbol: 'wti',
    name: '纽约原油',
    code: 'WTI CRUDE · USD / BBL',
    label: 'WTI',
    price: 74.16,
    prevClose: 74.42,
    open: 74.48,
    high: 74.73,
    low: 73.92,
    changeAmount: -0.26,
    changePercent: -0.35,
    quoteMinutesAgo: 12,
    delayed: true,
    seed: 20261111
  }
};

/**
 * 确定性伪随机数（mulberry32）：
 * 保证每次启动生成的走势曲线完全一致，不会每次刷新都在跳。
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一条从开盘价走到当前价的日内曲线。
 * @param {number} seed   随机种子
 * @param {number} open   开盘价
 * @param {number} price  当前价（曲线终点）
 * @param {number} count  点数
 */
function buildSeries(seed, open, price, count) {
  const rnd = mulberry32(seed);
  const values = [];
  const noise = Math.abs(price - open) * 0.16 + 0.22;
  let v = open;
  for (let i = 0; i < count; i++) {
    values.push(v);
    v += (rnd() - 0.5) * noise;
  }
  // 线性修正：让曲线从开盘价平滑走到当前价，
  // 否则最后一点会被强行拉成一根竖线，看着像行情跳空。
  const endDiff = price - values[count - 1];
  for (let i = 0; i < count; i++) {
    values[i] += endDiff * (i / (count - 1));
  }
  values[0] = open;
  values[count - 1] = price;
  return values;
}

/**
 * 行情周期配置
 *
 * stepMinutes：相邻两个点的真实间隔，1 日按 15 分钟、其余按 1 天。
 * 以前不管切哪个周期都按分钟间隔造点，切周期只是点数变了，曲线没区别。
 */
const MARKET_PERIODS = {
  '1d': { label: '1日', points: 28, stepMinutes: 15,   fromOpen: true, axis: 'time' },
  '1w': { label: '1周', points: 7,  stepMinutes: 1440, ratio: 0.982, axis: 'date' },
  '1m': { label: '1月', points: 30, stepMinutes: 1440, ratio: 0.958, axis: 'date' },
  '3m': { label: '3月', points: 90, stepMinutes: 1440, ratio: 0.914, axis: 'date' }
};

/** 轴标签：日内给 HH:MM，跨日给 MM-DD */
function marketAxisLabel(dateStr, mode) {
  if (mode === 'time') return String(dateStr).slice(11, 16);
  return String(dateStr).slice(5, 10);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 某个时刻在 UTC+8 下的日历字段。
 *
 * 小程序端在东八区、云函数可能在 UTC，两端各按本地时间打时间戳会错位，
 * 这里统一按 UTC+8 取字段。
 */
function utc8Parts(date) {
  var t = new Date(date.getTime() + 8 * 3600000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds()
  };
}

/**
 * 组装一个品种的完整行情载荷。
 *
 * 小程序端和云函数端共用这一份实现（云端副本由 scripts/sync-cloud-shared.js
 * 从本文件内联生成），避免两端再次分叉。
 */
function buildMarketPayload(symbol, period) {
  var key = MARKETS[symbol] ? symbol : 'brent';
  var m = MARKETS[key];
  var conf = MARKET_PERIODS[period] || MARKET_PERIODS['1d'];

  var start = conf.fromOpen ? m.open : round2(m.price * conf.ratio);
  var raw = buildSeries(m.seed + key.length + period.length, start, m.price, conf.points);
  var now = new Date();
  var quoteTime = new Date(now.getTime() - (m.quoteMinutesAgo || 0) * 60000);

  // 图表用的完整日期时间：带年份，横轴才能按真实时间比例排
  function fullStamp(d) {
    var p = utc8Parts(d);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + ' ' +
      pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
  }
  // 界面展示用的短格式
  function shortStamp(d) {
    var p = utc8Parts(d);
    return pad2(p.month) + '-' + pad2(p.day) + ' ' +
      pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
  }

  var step = (conf.stepMinutes || 15) * 60000;
  var points = raw.map(function (v, i) {
    var d = new Date(quoteTime.getTime() - (conf.points - 1 - i) * step);
    return { date: fullStamp(d), value: Number(v.toFixed(2)) };
  });

  return {
    symbol: key,
    name: m.name,
    code: m.code,
    label: m.label,
    price: m.price,
    changeAmount: m.changeAmount,
    changePercent: m.changePercent,
    direction: m.changeAmount < 0 ? 'down' : 'up',
    open: m.open,
    prevClose: m.prevClose,
    high: m.high,
    low: m.low,
    unit: '美元/桶',
    quoteTime: shortStamp(quoteTime),
    delayed: !!m.delayed,
    delayMinutes: m.quoteMinutesAgo || 0,
    period: conf.label,
    points: points,
    axis: [
      points[0] ? marketAxisLabel(points[0].date, conf.axis) : '',
      points[Math.floor(points.length / 2)] ? marketAxisLabel(points[Math.floor(points.length / 2)].date, conf.axis) : '',
      points[points.length - 1] ? marketAxisLabel(points[points.length - 1].date, conf.axis) : ''
    ]
  };
}


var DEMO_ANCHOR = "2026-11-10";

var FUELS = [
  {
    "id": "92",
    "name": "92# 汽油",
    "short": "92#",
    "unit": "元/升"
  },
  {
    "id": "95",
    "name": "95# 汽油",
    "short": "95#",
    "unit": "元/升"
  },
  {
    "id": "98",
    "name": "98# 汽油",
    "short": "98#",
    "unit": "元/升"
  },
  {
    "id": "0",
    "name": "0# 柴油",
    "short": "0#",
    "unit": "元/升"
  }
];

var REGIONS = [
  {
    "code": "440000",
    "name": "广东",
    "city": "广州",
    "offset": 0
  },
  {
    "code": "410000",
    "name": "河南",
    "city": "郑州",
    "offset": -0.02
  },
  {
    "code": "510000",
    "name": "四川",
    "city": "成都",
    "offset": 0.09
  },
  {
    "code": "110000",
    "name": "北京",
    "city": "北京",
    "offset": 0.05
  },
  {
    "code": "310000",
    "name": "上海",
    "city": "上海",
    "offset": 0.13
  },
  {
    "code": "330000",
    "name": "浙江",
    "city": "杭州",
    "offset": 0.08
  },
  {
    "code": "610000",
    "name": "陕西",
    "city": "西安",
    "offset": 0.02
  },
  {
    "code": "230000",
    "name": "黑龙江",
    "city": "哈尔滨",
    "offset": -0.06
  },
  {
    "code": "460000",
    "name": "海南",
    "city": "海口",
    "offset": 0.15
  },
  {
    "code": "650000",
    "name": "新疆",
    "city": "乌鲁木齐",
    "offset": 0.11
  }
];

var DEFAULT_REGION_CODE = "440000";

var ADJUSTMENTS = [
  {
    "date": "2025-11-15",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.1,
      "92": 0.1,
      "95": 0.11,
      "98": 0.12
    }
  },
  {
    "date": "2025-11-28",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.13,
      "92": -0.14,
      "95": -0.15,
      "98": -0.17
    }
  },
  {
    "date": "2025-12-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.05,
      "95": 0.06,
      "98": 0.06
    }
  },
  {
    "date": "2025-12-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.15,
      "92": -0.16,
      "95": -0.17,
      "98": -0.19
    }
  },
  {
    "date": "2026-01-15",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.11,
      "92": 0.12,
      "95": 0.13,
      "98": 0.14
    }
  },
  {
    "date": "2026-01-29",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.09,
      "92": -0.1,
      "95": -0.11,
      "98": -0.12
    }
  },
  {
    "date": "2026-02-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.07,
      "92": 0.08,
      "95": 0.09,
      "98": 0.09
    }
  },
  {
    "date": "2026-02-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.11,
      "92": -0.12,
      "95": -0.13,
      "98": -0.14
    }
  },
  {
    "date": "2026-03-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.06,
      "95": 0.07,
      "98": 0.07
    }
  },
  {
    "date": "2026-03-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.08,
      "92": -0.09,
      "95": -0.1,
      "98": -0.11
    }
  },
  {
    "date": "2026-04-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.1,
      "92": 0.11,
      "95": 0.12,
      "98": 0.13
    }
  },
  {
    "date": "2026-04-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.06,
      "92": -0.07,
      "95": -0.08,
      "98": -0.08
    }
  },
  {
    "date": "2026-05-12",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.05,
      "92": -0.06,
      "95": -0.07,
      "98": -0.07
    }
  },
  {
    "date": "2026-05-26",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.08,
      "92": 0.09,
      "95": 0.1,
      "98": 0.11
    }
  },
  {
    "date": "2026-06-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.12,
      "92": 0.13,
      "95": 0.14,
      "98": 0.15
    }
  },
  {
    "date": "2026-06-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.14,
      "92": -0.15,
      "95": -0.16,
      "98": -0.18
    }
  },
  {
    "date": "2026-07-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.06,
      "92": 0.07,
      "95": 0.08,
      "98": 0.08
    }
  },
  {
    "date": "2026-07-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.07,
      "92": -0.08,
      "95": -0.09,
      "98": -0.1
    }
  },
  {
    "date": "2026-08-12",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.04,
      "92": -0.05,
      "95": -0.06,
      "98": -0.06
    }
  },
  {
    "date": "2026-08-26",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.09,
      "92": 0.1,
      "95": 0.11,
      "98": 0.12
    }
  },
  {
    "date": "2026-09-07",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.04,
      "92": 0.04,
      "95": 0.05,
      "98": 0.05
    }
  },
  {
    "date": "2026-09-28",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.09,
      "92": -0.1,
      "95": -0.11,
      "98": -0.12
    }
  },
  {
    "date": "2026-10-20",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.06,
      "95": 0.07,
      "98": 0.07
    }
  },
  {
    "date": "2026-11-02",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.08,
      "92": -0.08,
      "95": -0.09,
      "98": -0.1
    }
  }
];

var NATIONAL_BASE = {
  "0": 7.19,
  "92": 7.55,
  "95": 8.17,
  "98": 9.07
};

/* ---------- 演示时钟：与小程序端 utils/demo-clock.js 同一套规则 ---------- */

function parseUtc(dateStr) {
  var m = String(dateStr).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function localDayNumber(date) {
  // 与小程序端 utils/demo-clock.js 一致：统一按 UTC+8 日历日算，
  // 否则客户端在东八区、云函数在 UTC 时，凌晨会差一天。
  var t = new Date(date.getTime() + 8 * 3600000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

function offsetDays() {
  var anchor = parseUtc(DEMO_ANCHOR);
  if (anchor === null) return 0;
  return Math.round((localDayNumber(new Date()) - anchor) / 86400000);
}

function shiftDate(dateStr) {
  if (!dateStr) return '';
  var base = parseUtc(dateStr);
  if (base === null) return dateStr;
  var d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays());
  return d.toISOString().slice(0, 10);
}

function today() {
  return shiftDate(DEMO_ANCHOR);
}

function daysUntil(dateStr) {
  var target = parseUtc(dateStr);
  if (target === null) return 0;
  var todayTs = parseUtc(today());
  return Math.round((target - todayTs) / 86400000);
}

/* ---------- 价格计算 ---------- */

function round2(v) {
  return Math.round(v * 100) / 100;
}

function regionByCode(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i].code === code) return REGIONS[i];
  }
  return REGIONS[0];
}

var LEVEL_CACHE = {};

function levels(fuelId) {
  if (LEVEL_CACHE[fuelId]) return LEVEL_CACHE[fuelId];
  var price = NATIONAL_BASE[fuelId];
  var list = [{ date: null, price: price, delta: 0, title: null }];
  ADJUSTMENTS.forEach(function (item) {
    price = round2(price + item.deltas[fuelId]);
    list.push({
      // 日期统一平移，和小程序端保持同一时间基准
      date: shiftDate(item.date),
      price: price,
      delta: item.deltas[fuelId],
      title: item.title
    });
  });
  LEVEL_CACHE[fuelId] = list;
  return list;
}

function nationalPriceOn(fuelId, dateStr) {
  var list = levels(fuelId);
  var price = list[0].price;
  for (var i = 1; i < list.length; i++) {
    if (list[i].date <= dateStr) price = list[i].price;
    else break;
  }
  return price;
}

function priceOn(regionCode, fuelId, dateStr) {
  var region = regionByCode(regionCode);
  return round2(nationalPriceOn(fuelId, dateStr) + region.offset);
}

function currentPrice(regionCode, fuelId) {
  return priceOn(regionCode, fuelId, today());
}

function allPrices() {
  var out = [];
  REGIONS.forEach(function (region) {
    FUELS.forEach(function (fuel) {
      var list = levels(fuel.id);
      out.push({
        regionCode: region.code,
        regionName: region.name + ' · ' + region.city,
        fuelId: fuel.id,
        fuelName: fuel.name,
        price: currentPrice(region.code, fuel.id),
        changeAmount: list[list.length - 1].delta,
        changeAt: list[list.length - 1].date
      });
    });
  });
  return out;
}

function dedupKey(sourceId, title, executeAt) {
  return [sourceId, String(executeAt || '').slice(0, 10), String(title || '').replace(/\s+/g, '')].join('::');
}

module.exports = {
  DEMO_ANCHOR: DEMO_ANCHOR,
  FUELS: FUELS,
  REGIONS: REGIONS,
  DEFAULT_REGION_CODE: DEFAULT_REGION_CODE,
  ADJUSTMENTS: ADJUSTMENTS,
  NATIONAL_BASE: NATIONAL_BASE,
  round2: round2,
  regionByCode: regionByCode,
  levels: levels,
  nationalPriceOn: nationalPriceOn,
  priceOn: priceOn,
  currentPrice: currentPrice,
  allPrices: allPrices,
  dedupKey: dedupKey,
  MARKETS: MARKETS,
  buildSeries: buildSeries,
  MARKET_PERIODS: MARKET_PERIODS,
  marketAxisLabel: marketAxisLabel,
  buildMarketPayload: buildMarketPayload,
  clock: { today: today, shiftDate: shiftDate, daysUntil: daysUntil, offsetDays: offsetDays }
};