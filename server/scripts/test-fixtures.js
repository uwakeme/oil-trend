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

/**
 * 灌一套演示数据到当前数据库连接
 * @returns {Promise<{ok: boolean, prices: number}>}
 */
function seed() {
  return Promise.all([
    dao.prices.removeBySource('seed'),
    dao.history.removeBySource('seed'),
    dao.events.removeBySource('seed'),
    dao.markets.removeBySource('seed')
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
    // 行情：直接用共享模块生成的曲线
    var marketTasks = ['brent', 'wti'].map(function (symbol) {
      var payload = shared.buildMarketPayload(symbol, '3m');
      return dao.markets.upsert({
        symbol: symbol,
        name: payload.name,
        price: payload.price,
        changeAmount: payload.changeAmount,
        changePercent: payload.changePercent,
        open: payload.open,
        prevClose: payload.prevClose,
        high: payload.high,
        low: payload.low,
        quoteTime: payload.quoteTime,
        delayed: payload.delayed,
        // 库里存 points 字段（{date, value}），不是 series
        series: payload.points || [],
        source: 'seed'
      });
    });
    return Promise.all(marketTasks);
  }).then(function () {
    return { ok: true, prices: shared.allPrices().length };
  });
}

module.exports = { seed: seed };
