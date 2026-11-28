/**
 * 测试夹具：往内存库里灌测试数据
 *
 * 为什么单独放一个文件，而不是留在 services/collector.js 里：
 *   collector.js 是生产代码，不该带着「写演示数据」的能力 ——
 *   生产库里出现演示数据是个事故。演示数据只属于测试。
 *
 * 三个测试脚本（selftest / http-test / check-openapi）都用它造数据。
 *
 * ⚠️ 这里的调价时间线与价格阶梯**只属于测试**：
 *    生产的价格来自采集器抓到的各省挂牌价，不再由「全国价 + 地区价差」算出来。
 *    留着这套模型是为了验证「地区价差」口径 ——
 *    算出来的价格要与 data/reference-prices.js 的基准逐项一致（自检里 124 个值）。
 */
const dao = require('../src/dao');
const shared = require('../src/shared/shared');

/* ---------------- 测试种子：调价时间线与价格阶梯 ---------------- */

/**
 * 测试用的全国调价时间线。
 *
 * 顺序：最早 → 最新。deltas 单位：元/升。
 */
const ADJUSTMENTS = [
  { date: '2025-11-15', title: '国内成品油价格按机制上调', deltas: { '92':  0.10, '95':  0.11, '98':  0.12, '0':  0.10 } },
  { date: '2025-11-28', title: '国内成品油价格按机制下调', deltas: { '92': -0.14, '95': -0.15, '98': -0.17, '0': -0.13 } },
  { date: '2025-12-12', title: '国内成品油价格按机制上调', deltas: { '92':  0.05, '95':  0.06, '98':  0.06, '0':  0.05 } },
  { date: '2025-12-26', title: '国内成品油价格按机制下调', deltas: { '92': -0.16, '95': -0.17, '98': -0.19, '0': -0.15 } },
  { date: '2026-01-15', title: '国内成品油价格按机制上调', deltas: { '92':  0.12, '95':  0.13, '98':  0.14, '0':  0.11 } },
  { date: '2026-01-29', title: '国内成品油价格按机制下调', deltas: { '92': -0.10, '95': -0.11, '98': -0.12, '0': -0.09 } },
  { date: '2026-02-12', title: '国内成品油价格按机制上调', deltas: { '92':  0.08, '95':  0.09, '98':  0.09, '0':  0.07 } },
  { date: '2026-02-26', title: '国内成品油价格按机制下调', deltas: { '92': -0.12, '95': -0.13, '98': -0.14, '0': -0.11 } },
  { date: '2026-03-12', title: '国内成品油价格按机制上调', deltas: { '92':  0.06, '95':  0.07, '98':  0.07, '0':  0.05 } },
  { date: '2026-03-26', title: '国内成品油价格按机制下调', deltas: { '92': -0.09, '95': -0.10, '98': -0.11, '0': -0.08 } },
  { date: '2026-04-12', title: '国内成品油价格按机制上调', deltas: { '92':  0.11, '95':  0.12, '98':  0.13, '0':  0.10 } },
  { date: '2026-04-26', title: '国内成品油价格按机制下调', deltas: { '92': -0.07, '95': -0.08, '98': -0.08, '0': -0.06 } },
  { date: '2026-05-12', title: '国内成品油价格按机制下调', deltas: { '92': -0.06, '95': -0.07, '98': -0.07, '0': -0.05 } },
  { date: '2026-05-26', title: '国内成品油价格按机制上调', deltas: { '92':  0.09, '95':  0.10, '98':  0.11, '0':  0.08 } },
  { date: '2026-06-12', title: '国内成品油价格按机制上调', deltas: { '92':  0.13, '95':  0.14, '98':  0.15, '0':  0.12 } },
  { date: '2026-06-26', title: '国内成品油价格按机制下调', deltas: { '92': -0.15, '95': -0.16, '98': -0.18, '0': -0.14 } },
  { date: '2026-07-12', title: '国内成品油价格按机制上调', deltas: { '92':  0.07, '95':  0.08, '98':  0.08, '0':  0.06 } },
  { date: '2026-07-26', title: '国内成品油价格按机制下调', deltas: { '92': -0.08, '95': -0.09, '98': -0.10, '0': -0.07 } },
  { date: '2026-08-12', title: '国内成品油价格按机制下调', deltas: { '92': -0.05, '95': -0.06, '98': -0.06, '0': -0.04 } },
  { date: '2026-08-26', title: '国内成品油价格按机制上调', deltas: { '92':  0.10, '95':  0.11, '98':  0.12, '0':  0.09 } },
  { date: '2026-09-07',  title: '国内成品油价格按机制上调', deltas: { '92':  0.04, '95':  0.05, '98':  0.05, '0':  0.04 } },
  { date: '2026-09-28', title: '国内成品油价格按机制下调', deltas: { '92': -0.10, '95': -0.11, '98': -0.12, '0': -0.09 } },
  { date: '2026-10-20', title: '国内成品油价格按机制上调', deltas: { '92':  0.06, '95':  0.07, '98':  0.07, '0':  0.05 } },
  { date: '2026-11-02', title: '国内成品油价格按机制下调', deltas: { '92': -0.08, '95': -0.09, '98': -0.10, '0': -0.08 } }
];

/**
 * 第一条调价发生「之前」的全国均价。
 *
 * 基准价是按「当期全国均价反推」得到的：各油品的全国均价减去到当期的调价累加幅度。
 * 校准后各地价格与各省发改委公布的最高零售价一致（自检里逐省比对 124 个值）。
 */
const NATIONAL_BASE = { '92': 9.13, '95': 9.73, '98': 11.04, '0': 8.75 };

/**
 * 日期锚点：种子数据按「今天 - 锚点」整体平移。
 *
 * ⚠️ 不平移的话，几周后这套种子就停在 2026-11-10：
 *    调价节点全落在过去、下一轮窗口早就过期，
 *    窗口倒计时与进度相关的断言会随日期漂。
 */
var ANCHOR = '2026-11-10';

function parseUtc(dateStr) {
  var m = String(dateStr).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 换算成「UTC+8 日历日」的 UTC 零点。
 *
 * 统一按 UTC+8 算：服务器跑 UTC 时，按本地日历日会差一天。
 */
function localDayNumber(date) {
  var t = new Date(date.getTime() + 8 * 3600000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** 相对锚点的天数偏移（今天为 0） */
function offsetDays() {
  var anchor = parseUtc(ANCHOR);
  if (anchor === null) return 0;
  return Math.round((localDayNumber(new Date()) - anchor) / 86400000);
}

/** 平移一个 YYYY-MM-DD 日期 */
function shiftDate(dateStr) {
  if (!dateStr) return '';
  var base = parseUtc(dateStr);
  if (base === null) return dateStr;
  var d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays());
  return d.toISOString().slice(0, 10);
}

/** 今天的 YYYY-MM-DD（平移后） */
function today() {
  return shiftDate(ANCHOR);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

var LEVEL_CACHE = {};

/** 某油品的全国价阶梯（日期已平移） */
function levels(fuelId) {
  if (LEVEL_CACHE[fuelId]) return LEVEL_CACHE[fuelId];
  var price = NATIONAL_BASE[fuelId];
  var list = [{ date: null, price: price, delta: 0, title: null }];
  ADJUSTMENTS.forEach(function (item) {
    price = round2(price + item.deltas[fuelId]);
    list.push({
      date: shiftDate(item.date),
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

/**
 * 某地某油品在某天的零售价
 *
 * ⚠️ 地区价差按油品分别取：现实中各省的标号结构不同
 * （98# 相对 92# 的溢价各省差 1.3 元/升），共用一套 offset 误差太大。
 */
function priceOn(regionCode, fuelId, dateStr) {
  var region = null;
  for (var i = 0; i < shared.REGIONS.length; i++) {
    if (shared.REGIONS[i].code === regionCode) { region = shared.REGIONS[i]; break; }
  }
  if (!region) return null;
  var offset = (region.offset && region.offset[fuelId] !== undefined) ? region.offset[fuelId] : 0;
  return round2(nationalPriceOn(fuelId, dateStr) + offset);
}

/** 某地某油品的当前价 */
function currentPrice(regionCode, fuelId) {
  return priceOn(regionCode, fuelId, today());
}

/** 全部地区 × 油品的当前价（灌库用） */
function allPrices() {
  var out = [];
  shared.REGIONS.forEach(function (region) {
    shared.FUELS.forEach(function (fuel) {
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

/* ---------------- 行情夹具 ---------------- */

/**
 * 造一条行情记录，形状与采集器写库的一致。
 *
 * ⚠️ 点的时间必须按「现在」生成：服务端切周期是按**最后一个点**往前切的
 *    （notices.js 的 sliceSeries），日期写死的话 1 日视图里只剩最后一个点，
 *    页面那半边曲线就测不到了。
 *
 * @param {string} symbol 'brent' | 'wti'
 */
function marketFixture(symbol) {
  var isWti = symbol === 'wti';
  var base = isWti ? 83.33 : 90.7;
  var source = isWti ? 'market-wti' : 'market-brent';
  var name = isWti ? 'NYMEX原油' : '布伦特原油';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function stampStr(d) {
    return dateStr(d) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' +
      pad2(d.getUTCSeconds());
  }

  // 报价时刻：20 分钟前（国际期货通常是延时行情）
  var quoteAt = new Date(Date.now() - 20 * 60000 + 8 * 3600000);
  var dayStart = Date.UTC(quoteAt.getUTCFullYear(), quoteAt.getUTCMonth(), quoteAt.getUTCDate());
  var series = [];
  var i;

  // 过去 90 天的日线（不含今天：今天有分钟线，同一天的日线那根会被丢掉）
  for (i = 90; i >= 1; i--) {
    var day = new Date(dayStart - i * 86400000);
    series.push({ date: dateStr(day), value: round2(base + 0.6 * Math.sin(i / 5)) });
  }
  // 今天的分钟线：每 30 分钟一点，到报价时刻
  var step = 30 * 60000;
  for (var t = 0; t <= quoteAt.getTime() - dayStart; t += step) {
    var at = new Date(dayStart + t);
    series.push({ date: stampStr(at), value: round2(base + 0.35 * Math.sin(t / 3600000)) });
  }

  var intraday = series.slice(90);
  var price = series[series.length - 1].value;
  var prevClose = series[89].value;
  var changeAmount = round2(price - prevClose);
  var values = series.map(function (p) { return p.value; });

  return {
    name: name,
    price: price,
    changeAmount: changeAmount,
    changePercent: round2(changeAmount / prevClose * 100),
    open: intraday.length ? intraday[0].value : price,
    prevClose: prevClose,
    high: Math.max.apply(null, values),
    low: Math.min.apply(null, values),
    quoteTime: stampStr(quoteAt),
    delayed: true,
    series: series,
    source: source
  };
}

/**
 * 灌一套测试数据到当前数据库连接
 * @returns {Promise<{ok: boolean, prices: number}>}
 */
function seed() {
  return Promise.all([
    dao.prices.removeBySource('seed'),
    dao.history.removeBySource('seed'),
    dao.events.removeBySource('seed'),
    dao.markets.removeBySource('seed'),
    // 行情夹具用真实来源 id（决定对外的口径说明），也要清：
    // 不清的话换夹具后旧行还留在库里，测的就不是这一份数据了。
    dao.markets.removeBySource('market-wti'),
    dao.markets.removeBySource('market-brent')
  ]).then(function () {
    // 当前价
    var priceDocs = allPrices().map(function (p) {
      return {
        regionCode: p.regionCode,
        regionName: p.regionName,
        fuelId: p.fuelId,
        fuelName: p.fuelName,
        price: p.price,
        changeAmount: p.changeAmount,
        changeAt: p.changeAt
      };
    });
    return dao.prices.upsertMany(priceDocs);
  }).then(function () {
    // 历史价：按调价节点回推
    var historyDocs = [];
    shared.REGIONS.forEach(function (region) {
      shared.FUELS.forEach(function (fuel) {
        var list = levels(fuel.id);
        list.forEach(function (level) {
          if (!level.date) return;
          historyDocs.push({
            regionCode: region.code,
            fuelId: fuel.id,
            date: level.date,
            price: level.price
          });
        });
      });
    });
    return dao.history.upsertMany(historyDocs);
  }).then(function () {
    // 调价节点
    // ⚠️ 必须带 dedupKey：这张表现在靠它去重，
    // 采集器每轮都会写同一个节点，没有去重键就会越积越多。
    var eventDocs = ADJUSTMENTS.map(function (a) {
      var date = shiftDate(a.date);
      return {
        dedupKey: ['seed', date].join('::'),
        date: date,
        title: a.title,
        deltas: a.deltas,
        source: 'seed'
      };
    });
    return dao.events.upsertMany(eventDocs);
  }).then(function () {
    // 下一轮调价窗口：按最后一次调价 + 10 天的周期推
    var levels92 = levels('92');
    var last = levels92[levels92.length - 1];
    var base = last && last.date ? new Date(last.date + 'T00:00:00Z') : new Date();
    var next = new Date(base.getTime() + 10 * 86400000);
    var nextDate = next.toISOString().slice(0, 10);
    return dao.windows.upsert({
      dedupKey: ['seed', nextDate].join('::'),
      date: nextDate,
      time: '24:00',
      cycleStart: nextDate,
      isOfficial: false,
      basis: '按 10 个工作日调价周期推算',
      // 预测是区间结构（direction / literMin / literMax / estimated），
      // 不是按油品 id 的字典 —— 来源只给整体区间，没有分油品幅度
      forecast: { direction: 'down', literMin: 0.08, literMax: 0.1, estimated: true },
      forecastDirection: 'down',
      source: 'seed'
    });
  }).then(function () {
    // 行情：造两条「长得像真实采集结果」的记录
    // ⚠️ 国际行情的演示数据已删，不能再调共享模块的生成器造曲线。
    //    但夹具仍需要行情记录 —— 否则接口返回空态，
    //    页面渲染（价格、轴标签、延时文案、口径）那一段就测不到了。
    var marketTasks = ['brent', 'wti'].map(function (symbol) {
      var fixture = marketFixture(symbol);
      return dao.markets.upsert({
        symbol: symbol,
        name: fixture.name,
        price: fixture.price,
        changeAmount: fixture.changeAmount,
        changePercent: fixture.changePercent,
        open: fixture.open,
        prevClose: fixture.prevClose,
        high: fixture.high,
        low: fixture.low,
        quoteTime: fixture.quoteTime,
        delayed: fixture.delayed,
        // 库里存 series 字段（{date, value} 点数组）
        series: fixture.series,
        source: fixture.source
      });
    });
    return Promise.all(marketTasks);
  }).then(function () {
    return { ok: true, prices: allPrices().length };
  });
}

module.exports = {
  seed: seed,
  currentPrice: currentPrice,
  priceOn: priceOn,
  levels: levels,
  allPrices: allPrices,
  ADJUSTMENTS: ADJUSTMENTS,
  today: today
};
