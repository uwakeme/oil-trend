/**
 * 清理脚本的判定逻辑自测
 *
 * 造三种数据混在一起，验证只删该删的：
 *   1. 演示数据（source=seed）
 *   2. 演示数据（source 为 NULL，但值和演示一致）—— 真实库里就是这样
 *   3. 真实数据（source 为 NULL，值和演示不同）—— 必须留着
 */
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const ROOT = path.resolve(__dirname, '..');
process.env.OIL_ALLOW_NO_DATABASE = '1';

async function main() {
  var db = newDb();
  var adapter = db.adapters.createPg();
  var dbModule = require(path.join(ROOT, 'src', 'db.js'));
  var pgPool = new adapter.Pool();
  dbModule.pool.query = function (text, params) { return pgPool.query(text, params); };
  await db.public.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

  var dao = require(path.join(ROOT, 'src', 'dao', 'index.js'));
  var shared = require(path.join(ROOT, 'src', 'shared', 'shared.js'));
  var collector = require(path.join(ROOT, 'src', 'services', 'collector.js'));

  // 灌演示数据
  await collector.seed();

  // 掺入一条「真实数据」：同样的地区油品，但价格不同、source 为 NULL
  await dao.prices.upsertMany([{
    regionCode: '440000', regionName: '广东 · 广州', fuelId: '92',
    fuelName: '92# 汽油', price: 99.99, changeAmount: 0, changeAt: '2026-11-20'
  }]);

  // 掺入一条真实历史价
  await dao.history.upsertMany([{
    regionCode: '440000', fuelId: '92', date: '2027-01-01', price: 88.88
  }]);

  var before = {
    prices: (await dao.prices.listAll()).length,
    history: (await dao.history.listByRegion('440000')).length,
    events: (await dao.events.listAll()).length,
    windows: (await dao.windows.latest()) ? 1 : 0,
    markets: (await dao.markets.listAll()).length
  };
  console.log('清理前:', JSON.stringify(before));

  // 跑清理（真删）
  process.argv.push('--execute');
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'clean-seed.js'))];
  require(path.join(ROOT, 'scripts', 'clean-seed.js'));

  await new Promise(function (r) { setTimeout(r, 1500); });

  var after = {
    prices: (await dao.prices.listAll()).length,
    history: (await dao.history.listByRegion('440000')).length,
    events: (await dao.events.listAll()).length,
    windows: (await dao.windows.latest()) ? 1 : 0,
    markets: (await dao.markets.listAll()).length
  };
  console.log('清理后:', JSON.stringify(after));

  // 真实数据必须还在
  var prices = await dao.prices.listAll();
  var kept = prices.filter(function (p) { return Number(p.price) === 99.99; });
  var hist = await dao.history.listByRegion('440000');
  var keptHist = hist.filter(function (h) { return Number(h.price) === 88.88; });

  console.log('\n--- 断言 ---');
  var ok = true;
  function assert(name, cond) {
    console.log((cond ? '  OK   ' : '  FAIL ') + name);
    if (!cond) ok = false;
  }
  assert('真实当前价还在', kept.length === 1);
  assert('真实历史价还在', keptHist.length === 1);
  assert('演示当前价已清空', prices.filter(function (p) { return Number(p.price) !== 99.99; }).length === 0);
  assert('演示调价节点已清空', after.events === 0);
  assert('演示行情已清空', after.markets === 0);

  if (!ok) process.exit(1);
}

main().catch(function (err) {
  console.error('异常:', err && err.stack ? err.stack : err);
  process.exit(1);
});
