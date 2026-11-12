/**
 * 清理演示数据
 *
 * ⚠️ 为什么不能简单按 source = 'seed' 删：
 *   seed 写 oil_prices / oil_price_history 时没写 source 字段（是 NULL），
 *   只有 oil_adjust_events / oil_windows / oil_markets 打了 'seed' 标记。
 *   所以判定演示数据要靠两条：
 *     1. source = 'seed'（打了标记的）
 *     2. 值与共享模块算出来的完全一致（没打标记但内容是演示数据）
 *
 *   反过来也不能只看「值一致」就删 —— 万一真实数据碰巧和演示值一样，
 *   删了就丢真数据。所以两条同时满足才删。
 *
 * ⚠️ 更重要的一点：真实数据一旦写进来，source 是 NULL 的话会被误判吗？
 *   不会 —— 真实采集写的价格来自接口，不会和共享模块算出的值逐条一致。
 *   但为了保险，脚本会先打印「将要删除什么」，确认无误再执行。
 *
 * 用法：
 *   node scripts/clean-seed.js            # 先看会删什么，不真删
 *   node scripts/clean-seed.js --execute  # 真删
 */
const db = require('../src/db');
const shared = require('../src/shared/shared');

var EXECUTE = process.argv.indexOf('--execute') !== -1;

/* ---------------- 演示数据的基准值 ---------------- */

/** 演示数据里出现过的所有当前价：(regionCode, fuelId) → price */
var demoPrices = {};
shared.allPrices().forEach(function (p) {
  demoPrices[p.regionCode + '|' + p.fuelId] = Number(p.price);
});

/**
 * 演示数据里出现过的所有历史价：(regionCode, fuelId) → Set(price)
 *
 * ⚠️ 不能拿日期拼 key：
 *   1. 库里 DATE 列读出来是 Date 对象，跟演示的 'YYYY-MM-DD' 字符串对不上；
 *   2. 演示数据的日期会整体平移，跟库里的日期本来就不一样。
 * 所以只按 (地区, 油品) + 价格值来判定 —— 真实采集来的价格
 * 不会正好落在演示价格集合里。
 */
var demoHistory = {};
shared.REGIONS.forEach(function (region) {
  shared.FUELS.forEach(function (fuel) {
    var key = region.code + '|' + fuel.id;
    if (!demoHistory[key]) demoHistory[key] = {};
    shared.levels(fuel.id).forEach(function (level) {
      demoHistory[key][Number(level.price)] = true;
    });
  });
});

/** 演示调价节点的日期集合 */
var demoEventDates = {};
shared.ADJUSTMENTS.forEach(function (a) { demoEventDates[a.date] = true; });

/* ---------------- 逐表判定 ---------------- */

function planPrices() {
  return db.query('SELECT id, region_code, fuel_id, price, source FROM oil_prices').then(function (rows) {
    return rows.map(function (r) {
      var key = r.region_code + '|' + r.fuel_id;
      var isDemo = r.source === 'seed' ||
        (demoPrices[key] !== undefined && Math.abs(Number(demoPrices[key]) - Number(r.price)) < 0.0001);
      return { id: r.id, demo: isDemo, why: r.source === 'seed' ? 'source=seed' : ('值与演示一致(' + key + ')') };
    });
  });
}

function planHistory() {
  return db.query('SELECT id, region_code, fuel_id, date, price, source FROM oil_price_history').then(function (rows) {
    return rows.map(function (r) {
      var key = r.region_code + '|' + r.fuel_id;
      var set = demoHistory[key];
      var isDemo = r.source === 'seed' ||
        (set !== undefined && set[Number(r.price)] === true);
      return { id: r.id, demo: isDemo, why: r.source === 'seed' ? 'source=seed' : ('价格与演示一致(' + key + '=' + r.price + ')') };
    });
  });
}

function planEvents() {
  return db.query('SELECT id, date, source FROM oil_adjust_events').then(function (rows) {
    return rows.map(function (r) {
      var isDemo = r.source === 'seed' || demoEventDates[r.date] === true;
      return { id: r.id, demo: isDemo, why: r.source === 'seed' ? 'source=seed' : ('日期在演示调价表里(' + r.date + ')') };
    });
  });
}

function planBySource(table) {
  return db.query('SELECT id, source FROM ' + table).then(function (rows) {
    return rows.map(function (r) {
      return { id: r.id, demo: r.source === 'seed', why: 'source=seed' };
    });
  });
}

/* ---------------- 执行 ---------------- */

function deleteIds(table, ids) {
  if (!ids.length) return Promise.resolve(0);
  // 分批删，避免参数过多
  var deleted = 0;
  var batches = [];
  for (var i = 0; i < ids.length; i += 200) {
    batches.push(ids.slice(i, i + 200));
  }
  return batches.reduce(function (chain, batch) {
    return chain.then(function () {
      var placeholders = batch.map(function (_, i) { return '$' + (i + 1); }).join(',');
      // db.query 返回的是 rows（DELETE 时为空数组），删了几行要自己数
      return db.query('DELETE FROM ' + table + ' WHERE id IN (' + placeholders + ')', batch).then(function () {
        deleted += batch.length;
      });
    });
  }, Promise.resolve()).then(function () { return deleted; });
}

function main() {
  return Promise.all([
    planPrices(),
    planHistory(),
    planEvents(),
    planBySource('oil_windows'),
    planBySource('oil_markets')
  ]).then(function (plans) {
    var tables = [
      { name: 'oil_prices', label: '当前价', plan: plans[0] },
      { name: 'oil_price_history', label: '历史价', plan: plans[1] },
      { name: 'oil_adjust_events', label: '调价节点', plan: plans[2] },
      { name: 'oil_windows', label: '调价窗口', plan: plans[3] },
      { name: 'oil_markets', label: '国际行情', plan: plans[4] }
    ];

    console.log('\n=== 清理计划 ===');
    var total = 0;
    tables.forEach(function (t) {
      var demo = t.plan.filter(function (x) { return x.demo; });
      var keep = t.plan.length - demo.length;
      total += demo.length;
      console.log(t.label + ' (' + t.name + '): 删 ' + demo.length + ' 行，保留 ' + keep + ' 行');
      demo.slice(0, 3).forEach(function (d) {
        console.log('    - #' + d.id + '  ' + d.why);
      });
      if (demo.length > 3) console.log('    ... 还有 ' + (demo.length - 3) + ' 行');
    });
    console.log('\n合计将删除 ' + total + ' 行演示数据');

    if (!EXECUTE) {
      console.log('\n这是预览。加 --execute 才真删：node scripts/clean-seed.js --execute');
      return null;
    }

    if (total === 0) {
      console.log('\n没有演示数据，无需清理');
      return null;
    }

    return tables.reduce(function (chain, t) {
      return chain.then(function () {
        var ids = t.plan.filter(function (x) { return x.demo; }).map(function (x) { return x.id; });
        return deleteIds(t.name, ids).then(function (n) {
          console.log('  ' + t.label + ' 已删 ' + n + ' 行');
        });
      });
    }, Promise.resolve()).then(function () {
      console.log('\n清理完成。');
    });
  });
}

main().catch(function (err) {
  console.error('清理失败：', err && err.message ? err.message : err);
  process.exit(1);
});
