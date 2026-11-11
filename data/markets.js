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

module.exports = {
  MARKETS,
  buildSeries,
  MARKET_PERIODS,
  marketAxisLabel,
  buildMarketPayload
};
