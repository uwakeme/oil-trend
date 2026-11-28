/**
 * 测试夹具：往内存库里灌演示数据
 *
 * 为什么单独放一个文件，而不是留在 services/collector.js 里：
 *   collector.js 是生产代码，不该带着「写演示数据」的能力 ——
 *   生产库里出现演示数据是个事故。演示数据只属于测试。
 *
 * 三个测试脚本（selftest / http-test / check-openapi）都用它造数据。
 */
const dao = require('../src/dao');
const shared = require('../src/shared/shared');

/* ---------------- 行情夹具 ---------------- */

function round2(v) {
  return Math.round(v * 100) / 100;
}

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
 * 灌一套演示数据到当前数据库连接
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
    var priceDocs = shared.allPrices().map(function (p) {
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
        var list = shared.levels(fuel.id);
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
    var eventDocs = shared.ADJUSTMENTS.map(function (a) {
      return {
        dedupKey: ['seed', a.date].join('::'),
        date: a.date,
        title: a.title,
        deltas: a.deltas,
        source: 'seed'
      };
    });
    return dao.events.upsertMany(eventDocs);
  }).then(function () {
    // 下一轮调价窗口：按最后一次调价 + 10 天的周期推
    var levels92 = shared.levels('92');
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
    return { ok: true, prices: shared.allPrices().length };
  });
}

module.exports = { seed: seed };
