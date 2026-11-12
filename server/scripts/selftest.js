/**
 * 端到端自检：用 pg-mem 起一个内存 PostgreSQL，
 * 真建表、真灌数据、真调接口，验证返回结构与云函数一致。
 *
 * 为什么用 pg-mem 而不是真库：
 *   本机不一定装了 PostgreSQL，而这个项目最需要守住的不是「能连上库」，
 *   而是「返回结构对不对」—— 结构不对前端会静默回落到演示数据，
 *   页面看着正常但实际没走后端。pg-mem 能验证 SQL 与结构。
 *
 * 用法：node scripts/selftest.js
 */
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const ROOT = path.resolve(__dirname, '..');

var failures = [];
var checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log('  OK   ' + name);
  } else {
    console.log('  FAIL ' + name + (detail ? (' —— ' + detail) : ''));
    failures.push(name);
  }
}

/** 从统一外壳里取业务数据 */
function unwrap(res) {
  if (res && res.body && res.body.ok) return res.body.data;
  return null;
}

async function main() {
  // 自检用内存库，不需要真实的连接串
  process.env.OIL_ALLOW_NO_DATABASE = '1';

  // 建库
  var db = newDb();
  var adapter = db.adapters.createPg();

  // 把 pg-mem 的 Pool 注入 db.js：
  // 换成真 Pool 的话要连真库，自检不该依赖环境。
  var dbModule = require(path.join(ROOT, 'src', 'db.js'));
  var pgPool = new adapter.Pool();
  dbModule.pool.query = function (text, params) {
    return pgPool.query(text, params);
  };

  // 真正执行 schema.sql
  var schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  await db.public.query(schema);

  console.log('\n--- 建表 ---');
  var tables = await db.public.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  var names = (tables.rows || []).map(function (r) { return r.table_name; });
  var expected = ['alert_logs', 'alert_rules', 'collector_runs', 'oil_adjust_events',
    'oil_markets', 'oil_notices', 'oil_price_history', 'oil_prices', 'oil_users', 'oil_windows'];
  expected.forEach(function (t) {
    check('表 ' + t + ' 已创建', names.indexOf(t) !== -1);
  });

  // 灌演示数据（测试夹具，不在生产代码里）
  console.log('\n--- 灌演示数据 ---');
  var fixtures = require(path.join(ROOT, 'scripts', 'test-fixtures.js'));
  var seedResult = await fixtures.seed();
  check('seed 返回成功', !!(seedResult && seedResult.ok));

  var dao = require(path.join(ROOT, 'src', 'dao', 'index.js'));
  var shared = require(path.join(ROOT, 'src', 'shared', 'shared.js'));
  var priceCount = (await dao.prices.listAll()).length;
  var regionCount = shared.REGIONS.length;
  var fuelCount = shared.FUELS.length;
  check('当前价已写入（地区数 × 油品数 = ' + (regionCount * fuelCount) + '）',
    priceCount === regionCount * fuelCount, '实际 ' + priceCount);

  var historyCount = (await dao.history.listByRegion('440000')).length;
  check('广东历史价已写入', historyCount > 0, '实际 ' + historyCount);

  var eventCount = (await dao.events.listAll()).length;
  check('调价节点已写入（24 条）', eventCount === 24, '实际 ' + eventCount);

  // 造一条已复核的通知
  await dao.notices.insert({
    dedupKey: 'test::2026-11-12::selftest',
    kind: 'official',
    title: '国内成品油价格按机制上调',
    publishedAt: new Date().toISOString(),
    executeAt: '2026-11-12',
    changes: { '92': 0.15, '95': 0.15, '98': 0.15, '0': 0.15 },
    summary: '自检数据',
    prices: {},
    source: { name: '自检' },
    reviewStatus: 'approved'
  });
  // 再造一条待复核的：不应该对外可见
  await dao.notices.insert({
    dedupKey: 'test::2026-11-13::pending',
    kind: 'official',
    title: '未复核的通知',
    publishedAt: new Date().toISOString(),
    executeAt: '2026-11-13',
    changes: { '92': -0.2 },
    reviewStatus: 'pending'
  });

  console.log('\n--- 接口返回结构 ---');
  var query = require(path.join(ROOT, 'src', 'services', 'query.js'));
  var notices = require(path.join(ROOT, 'src', 'services', 'notices.js'));

  var regions = await query.actionRegions();
  check('regions 数量与地区表一致', regions.regions.length === shared.REGIONS.length,
    '实际 ' + regions.regions.length + ' vs ' + shared.REGIONS.length);
  check('regions 带 price92', regions.regions[0].price92 !== null && regions.regions[0].price92 !== undefined);
  check('regions 有 fullName', typeof regions.regions[0].fullName === 'string');

  var home = await query.actionHome({ regionCode: '440000' });
  check('home 有 prices', Array.isArray(home.prices) && home.prices.length === 4);
  check('home 有 window', !!home.window && typeof home.window.daysLeft === 'number');
  check('home 有 trend30', !!home.trend30 && Array.isArray(home.trend30['92'].points));
  check('home 有 changes', !!home.changes);
  check('home 有 source', home.source && home.source.mode === 'server');

  // ⚠️ 值也要对，不能只验字段存在：
  // DATE 列没转成 'YYYY-MM-DD' 字符串时，daysLeft 会变 null、
  // 走势曲线会是空数组 —— 字段都在，值全错，页面看着像没数据。
  check('window.date 是 YYYY-MM-DD 字符串', typeof home.window.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(home.window.date), String(home.window.date));
  check('window.daysLeft 是有效数字', typeof home.window.daysLeft === 'number' &&
    isFinite(home.window.daysLeft), String(home.window.daysLeft));
  check('window.progress 在 0~100 之间', typeof home.window.progress === 'number' &&
    home.window.progress >= 0 && home.window.progress <= 100, String(home.window.progress));
  check('trend30 有实际数据点（不是空数组）', home.trend30['92'].points.length > 0,
    '点数 ' + home.trend30['92'].points.length);
  check('trend30 的点日期是 YYYY-MM-DD', home.trend30['92'].points.length === 0 ||
    /^\d{4}-\d{2}-\d{2}$/.test(home.trend30['92'].points[0].date),
    home.trend30['92'].points.length ? home.trend30['92'].points[0].date : '无数据');
  check('price.changeAt 是 YYYY-MM-DD', typeof home.prices[0].changeAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(home.prices[0].changeAt), String(home.prices[0].changeAt));
  check('price.id 是字符串（不是数字）', typeof home.prices[0].id === 'string',
    typeof home.prices[0].id + ' ' + home.prices[0].id);

  var trend = await query.actionTrend({ regionCode: '440000', fuelId: '92', period: '3m' });
  check('trend 有 points', Array.isArray(trend.points) && trend.points.length > 0);
  check('trend 有 axis', Array.isArray(trend.axis) && trend.axis.length === 3);
  check('trend 有 events', Array.isArray(trend.events));
  check('trend 有 low/high', typeof trend.low === 'number' && typeof trend.high === 'number');

  var noticeList = await notices.actionNotices({ regionCode: '440000', filter: 'official' });
  check('notices 只返回已复核的（1 条）', noticeList.notices.length === 1, '实际 ' + noticeList.notices.length);
  check('notices 有 sync 状态', !!noticeList.sync && typeof noticeList.sync.status === 'string');
  check('notices 有 window', !!noticeList.window);

  var market = await notices.actionMarket({ symbol: 'brent', period: '1d' });
  check('market 有 price', typeof market.price === 'number');
  check('market 有 points', Array.isArray(market.points) && market.points.length > 0);

  var sync = await notices.actionSyncStatus();
  check('sync-status 有 status', typeof sync.status === 'string');
  check('sync-status 初始为 idle', sync.status === 'idle', '实际 ' + sync.status);

  console.log('\n--- 用户数据 ---');
  var user = require(path.join(ROOT, 'src', 'services', 'user.js'));
  await user.actionRulesSave('openid-test', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetPrice: 7.2, subscribeGranted: true }
  ]);
  var rules = await user.actionRulesList('openid-test');
  check('规则已保存并能读回', rules.rules.length === 1);
  check('规则带 targetPrice', rules.rules[0].targetPrice === 7.2);

  await user.actionRulesSave('openid-test', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetPrice: 7.1, subscribeGranted: true }
  ]);
  var rules2 = await user.actionRulesList('openid-test');
  check('重复保存走 upsert（仍是 1 条）', rules2.rules.length === 1, '实际 ' + rules2.rules.length);
  check('upsert 后值已更新', rules2.rules[0].targetPrice === 7.1);

  console.log('\n--- 提醒匹配 ---');
  var alert = require(path.join(ROOT, 'src', 'services', 'alert.js'));
  var hits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true, targetEnabled: true, targetPrice: 99 },
    [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
    { kind: 'official', executeAt: '2026-11-12', changes: { '92': -0.08 } },
    null
  );
  check('官方降价能命中', hits.some(function (h) { return h.type === 'officialDrop'; }));
  check('未授权的规则不产生命中', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', subscribeGranted: false },
    [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
    { kind: 'official', executeAt: '2026-11-12', changes: { '92': -0.08 } },
    null
  ).length === 0);

  console.log('\n--- 三端数值一致性 ---');
  var demo = require(path.join(ROOT, '..', 'data', 'demo.js'));

  console.log('\n--- 各省价格 vs 真实挂牌价 ---');
  // data/reference-prices.js 是各省发改委公布的最高零售价基准。
  // 算出来的价格必须与它一致 —— 这条守住「地区价差」模型的核心正确性：
  // offset 写错、基准价没校准、offset 忘了按油品分列，都会被抓出来。
  var reference = require(path.join(ROOT, '..', 'data', 'reference-prices.js')).REFERENCE_PRICES;
  var priceMismatch = [];
  var compared = 0;
  shared.REGIONS.forEach(function (region) {
    var ref = reference[region.name];
    if (!ref) {
      priceMismatch.push(region.name + ' 没有基准价');
      return;
    }
    shared.FUELS.forEach(function (fuel) {
      compared++;
      var calc = demo.currentPrice(region.code, fuel.id);
      if (Math.abs(calc - ref[fuel.id]) > 0.011) {
        priceMismatch.push(region.name + ' ' + fuel.id + '# 算 ' + calc.toFixed(2) +
          ' 基准 ' + ref[fuel.id].toFixed(2));
      }
    });
  });
  // 基准表里不该有地区表里没有的省份
  Object.keys(reference).forEach(function (name) {
    var found = shared.REGIONS.some(function (r) { return r.name === name; });
    if (!found) priceMismatch.push('基准里有 ' + name + ' 但地区表里没有');
  });
  check('各省价格与真实挂牌价一致（' + compared + ' 个值）', priceMismatch.length === 0,
    priceMismatch.slice(0, 5).join('；'));

  var mismatch = 0;
  shared.REGIONS.forEach(function (region) {
    shared.FUELS.forEach(function (fuel) {
      if (Math.abs(demo.currentPrice(region.code, fuel.id) - shared.currentPrice(region.code, fuel.id)) > 0.0001) {
        mismatch++;
      }
    });
  });
  check('服务端与小程序端价格完全一致', mismatch === 0, mismatch + ' 组不一致');

  console.log('\n--- 汇总 ---');
  console.log('检查 ' + checks + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length) {
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
    process.exit(1);
  }
  console.log('全部通过。');
}

main().catch(function (err) {
  console.error('\n自检异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
