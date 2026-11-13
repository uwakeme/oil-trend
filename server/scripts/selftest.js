/**
 * 端到端自检：用 pg-mem 起一个内存 PostgreSQL，
 * 真建表、真灌数据、真调接口，验证返回结构符合小程序端的期望。
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

  // DATE 列转换：pg 把 DATE 解析成「本地零点」的 Date，
  // 用 toISOString() 取日期在 UTC+8 会整体退一天（生产上真踩过）。
  // pg-mem 返回的是字符串，所以下面这条是唯一能钉住该行为的断言。
  console.log('\n--- DATE 列转换 ---');
  var localMidnight = new Date(2026, 10, 12, 0, 0, 0);
  var expectLocal = localMidnight.getFullYear() + '-' +
    ('0' + (localMidnight.getMonth() + 1)).slice(-2) + '-' +
    ('0' + localMidnight.getDate()).slice(-2);
  var gotLocal = dao.toDateString(localMidnight);
  check('本地零点 Date 按本地日历日转字符串', gotLocal === expectLocal,
    '实际 ' + gotLocal + '，期望 ' + expectLocal);
  check('已是字符串的日期原样返回', dao.toDateString('2026-11-12') === '2026-11-12');
  check('null 原样返回', dao.toDateString(null) === null);

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

  console.log('\n--- 订阅消息模板契约 ---');
  // 平台模板的字段名和值格式是硬约束：
  // 字段名对不上 → errcode 47003；值格式不对 → 47002。
  // 这里钉住契约表与三类提醒的 data，任何一边改了都要在这里暴露。
  var templates = require(path.join(ROOT, 'src', 'services', 'subscribe-templates.js'));
  var templateId = templates.PRIMARY_TEMPLATE_ID;
  var tpl = templates.templateOf(templateId);
  check('主模板已登记在契约表里', !!tpl);
  check('模板字段与平台一致（thing5/amount2/phrase1/date3/thing4）',
    !!tpl && Object.keys(tpl.fields).sort().join(',') === 'amount2,date3,phrase1,thing4,thing5',
    tpl ? Object.keys(tpl.fields).sort().join(',') : '无');

  check('金额带「元」且不带「元/升」', templates.formatAmount(0.13) === '0.13元',
    String(templates.formatAmount(0.13)));
  check('金额对空值返回 null（不能变成 0.00元）', templates.formatAmount(null) === null);
  check('日期转中文年月日', templates.formatDate('2026-11-24') === '2026年11月24日',
    String(templates.formatDate('2026-11-24')));
  check('短语截到 5 字', templates.formatPhrase('预计下调再涨').length === 5);
  check('文本截到 20 字', templates.formatThing('一二三四五六七八九十一二三四五六七八九十').length === 20);

  var baseData = {
    thing5: '92# 汽油', amount2: '0.13元', phrase1: '下调',
    date3: '2026年11月24日', thing4: '广东现价7.36元'
  };
  function withField(key, value) {
    var copy = Object.assign({}, baseData);
    copy[key] = value;
    return copy;
  }
  var badAmount = templates.validate(templateId, withField('amount2', '0.13 元/升'));
  check('金额带「元/升」会被契约挡住',
    !badAmount.ok && badAmount.errors.some(function (e) { return e.indexOf('BAD_AMOUNT') === 0; }),
    badAmount.errors.join(','));
  var badDate = templates.validate(templateId, withField('date3', '2026-11-24'));
  check('ISO 日期会被契约挡住',
    !badDate.ok && badDate.errors.some(function (e) { return e.indexOf('BAD_DATE') === 0; }),
    badDate.errors.join(','));
  var badField = templates.validate(templateId, { thing1: '92# 汽油' });
  check('模板里没有的字段名会被挡住',
    !badField.ok && badField.errors.some(function (e) { return e.indexOf('UNKNOWN_FIELD') === 0; }),
    badField.errors.join(','));
  var missingField = templates.validate(templateId, { thing5: '92# 汽油' });
  check('漏填字段会被挡住',
    !missingField.ok && missingField.errors.some(function (e) { return e.indexOf('MISSING') === 0; }),
    missingField.errors.join(','));
  check('合规数据能通过契约', templates.validate(templateId, baseData).ok,
    templates.validate(templateId, baseData).errors.join(','));

  console.log('\n--- 三类提醒的模板取值 ---');
  var tHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92',
      officialDrop: true, targetEnabled: true, targetPrice: 7.5, forecastDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
    { kind: 'official', executeAt: '2026-11-24', changes: { '92': -0.08 } },
    { kind: 'forecast', executeAt: '2026-11-26', changes: { '92': -0.06 } }
  );
  var hitByType = {};
  tHits.forEach(function (h) { hitByType[h.type] = h; });
  ['officialDrop', 'targetPrice', 'forecastDrop'].forEach(function (type) {
    var hit = hitByType[type];
    check(type + ' 能命中', !!hit);
    if (!hit) return;
    var v = templates.validate(templateId, hit.data);
    check(type + ' 的 data 通过模板契约', v.ok, v.errors.join(','));
    check(type + ' 的字段名与契约完全一致',
      Object.keys(hit.data).sort().join(',') === Object.keys(tpl.fields).sort().join(','),
      Object.keys(hit.data).sort().join(','));
  });
  if (hitByType.officialDrop) {
    check('官方降价的金额是降价幅度', hitByType.officialDrop.data.amount2 === '0.08元',
      hitByType.officialDrop.data.amount2);
    check('官方降价的方向是「下调」', hitByType.officialDrop.data.phrase1 === '下调',
      hitByType.officialDrop.data.phrase1);
    check('官方降价的日期是执行日', hitByType.officialDrop.data.date3 === '2026年11月24日',
      hitByType.officialDrop.data.date3);
    check('官方降价的温馨提示带地区与现价',
      hitByType.officialDrop.data.thing4.indexOf('广东') === 0 &&
      hitByType.officialDrop.data.thing4.indexOf('7.36') > 0,
      hitByType.officialDrop.data.thing4);
  }
  if (hitByType.targetPrice) {
    check('目标价的金额填的是目标价', hitByType.targetPrice.data.amount2 === '7.50元',
      hitByType.targetPrice.data.amount2);
    check('目标价的方向是「已达目标」', hitByType.targetPrice.data.phrase1 === '已达目标',
      hitByType.targetPrice.data.phrase1);
    check('目标价的日期是今天（UTC+8）',
      hitByType.targetPrice.data.date3 === templates.formatDate(alert.todayCN()),
      hitByType.targetPrice.data.date3 + ' vs ' + templates.formatDate(alert.todayCN()));
  }
  if (hitByType.forecastDrop) {
    check('预测下调的方向是「预计下调」', hitByType.forecastDrop.data.phrase1 === '预计下调',
      hitByType.forecastDrop.data.phrase1);
    check('预测下调的温馨提示标明非官方',
      hitByType.forecastDrop.data.thing4.indexOf('以官方为准') > 0,
      hitByType.forecastDrop.data.thing4);
  }
  check('地区名取自地区表（不是地区代码）', alert.regionNameOf('440000') === '广东',
    alert.regionNameOf('440000'));
  check('未知地区不静默回退成上海', alert.regionNameOf('999999') === '999999',
    alert.regionNameOf('999999'));
  check('目标价开关关掉时不命中',
    alert.matchRule(
      { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: false, targetEnabled: false, targetPrice: 99 },
      [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
      null, null
    ).length === 0);

  console.log('\n--- 提醒规则字段映射 ---');
  await user.actionRulesSave('openid-fields', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetEnabled: false,
      targetPrice: 7.15, forecastDrop: true, subscribeGranted: true }
  ]);
  var fr = (await user.actionRulesList('openid-fields')).rules[0];
  check('forecastDrop 能存能读（前端字段名）', fr.forecastDrop === true, String(fr.forecastDrop));
  check('targetEnabled 能存能读', fr.targetEnabled === false, String(fr.targetEnabled));
  check('targetPrice 读回来是数字', typeof fr.targetPrice === 'number' &&
    Math.abs(fr.targetPrice - 7.15) < 0.001, String(fr.targetPrice));
  check('subscribeGranted 读回 true', fr.subscribeGranted === true);

  await dao.rules.consumeSubscribe({ userId: 'openid-fields', regionCode: '440000', fuelId: '92' });
  var afterUse = (await user.actionRulesList('openid-fields')).rules[0];
  check('额度用掉后 subscribeGranted 变 false', afterUse.subscribeGranted === false);
  check('额度用掉后有 subscribeUsedAt', !!afterUse.subscribeUsedAt);

  await user.actionRulesSave('openid-fields', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetEnabled: false,
      targetPrice: 7.15, forecastDrop: true }
  ]);
  var afterPlain = (await user.actionRulesList('openid-fields')).rules[0];
  check('普通保存不会把已用掉的额度续上', afterPlain.subscribeGranted === false);
  check('普通保存不会清掉「已用完」标记', !!afterPlain.subscribeUsedAt);

  await user.actionRulesSave('openid-fields', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetEnabled: false,
      targetPrice: 7.15, forecastDrop: true, subscribeGranted: true }
  ]);
  var afterGrant = (await user.actionRulesList('openid-fields')).rules[0];
  check('重新授权后额度恢复', afterGrant.subscribeGranted === true);
  check('重新授权后清掉「已用完」标记', !afterGrant.subscribeUsedAt);

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

  // 经纬度 → 省份：小程序「自动定位所在省」的基础。
  // 这里钉住每个省的省会坐标，省界数据被误改时会立刻暴露。
  console.log('\n--- 省界反查 ---');
  var locate = require(path.join(ROOT, 'src', 'services', 'locate.js'));
  var provinceSamples = [
    ['北京', 39.904989, 116.405285],
    ['天津', 39.125596, 117.190182],
    ['河北', 38.042307, 114.514861],
    ['山西', 37.870590, 112.548879],
    ['内蒙古', 40.841490, 111.751990],
    ['辽宁', 41.805699, 123.431474],
    ['吉林', 43.817072, 125.323544],
    ['黑龙江', 45.803775, 126.534967],
    ['上海', 31.230416, 121.473701],
    ['江苏', 32.060255, 118.796877],
    ['浙江', 30.287459, 120.153576],
    ['安徽', 31.820586, 117.227219],
    ['福建', 26.074507, 119.296494],
    ['江西', 28.682022, 115.858198],
    ['山东', 36.651225, 117.120085],
    ['河南', 34.757975, 113.665412],
    ['湖北', 30.584355, 114.298456],
    ['湖南', 28.228209, 112.938814],
    ['广东', 23.129112, 113.264385],
    ['广西', 22.817002, 108.366543],
    ['海南', 20.044220, 110.199890],
    ['重庆', 29.563009, 106.551556],
    ['四川', 30.659462, 104.065735],
    ['贵州', 26.647661, 106.630153],
    ['云南', 25.038864, 102.718267],
    ['西藏', 29.660357, 91.114857],
    ['陕西', 34.263161, 108.948024],
    ['甘肃', 36.061089, 103.834303],
    ['青海', 36.617144, 101.778228],
    ['宁夏', 38.466370, 106.278179],
    ['新疆', 43.825592, 87.616848]
  ];
  var locateMiss = [];
  provinceSamples.forEach(function (item) {
    var got = locate.locateByLatLng(item[1], item[2]);
    if (got.regionName !== item[0] || got.match !== 'inside') {
      locateMiss.push(item[0] + ' → ' + got.regionName + '(' + got.match + ')');
    }
  });
  check('各省省会坐标全部落对省界内（' + provinceSamples.length + ' 个）', locateMiss.length === 0,
    locateMiss.slice(0, 5).join('；'));
  check('境外坐标匹配不到省份', locate.locateByLatLng(35.689487, 139.691711).match === 'none');
  check('非法参数匹配不到省份', locate.locateByLatLng('abc', undefined).match === 'none');
  check('越界坐标匹配不到省份', locate.locateByLatLng(200, 200).match === 'none');
  var geoData = require(path.join(ROOT, 'src', 'data', 'provinces.json'));
  check('省界数据覆盖全部支持地区（' + shared.REGIONS.length + ' 个）',
    geoData.provinces.length === shared.REGIONS.length,
    geoData.provinces.length + ' 个');

  console.log('\n--- 机器判定的可信度 ---');
  // review_status 是机器判定的可信度标记，不是人工审核结论。
  // 这里钉住三件事：存疑的通知不装猜的幅度、存疑的不对外发布、
  // 存疑的能被更可信的解析结果覆盖（否则解析器修好了重跑也进不来）。
  var collector = require(path.join(ROOT, 'src', 'services', 'collector.js'));
  var ndrcSource = { id: 'ndrc-notice', name: '国家发展改革委价格监测中心', url: 'https://example.invalid/' };
  var ndrcParsed = {
    kind: 'official',
    title: '国内成品油价格按机制下调',
    executeAt: '2026-11-24',
    delta: -0.08,
    deltas: {},
    perFuel: false,
    reviewStatus: 'pending',
    raw: '自2026年11月24日24时起，每升下调0.08元。'
  };
  var ndrcKey = shared.dedupKey(ndrcSource.id, ndrcParsed.title, ndrcParsed.executeAt);

  await collector.saveNotice(ndrcSource, ndrcParsed);
  var pendingNotice = await dao.notices.findByDedupKey(ndrcKey);
  check('存疑的通知能入库', !!pendingNotice && !!pendingNotice.id);
  check('存疑的通知 reviewStatus 是 pending', pendingNotice && pendingNotice.reviewStatus === 'pending',
    pendingNotice && pendingNotice.reviewStatus);
  check('存疑的通知里没有猜出来的幅度',
    pendingNotice && Object.keys(pendingNotice.changes || {}).length === 0,
    pendingNotice ? JSON.stringify(pendingNotice.changes) : '无');
  var publicAfterPending = await dao.notices.listPublic('official', 50, 0);
  check('存疑的通知不对外发布',
    !publicAfterPending.some(function (n) { return n.dedupKey === ndrcKey; }));

  // 解析器修好后重跑采集：同一条去重键要被更可信的结果覆盖
  await collector.saveNotice(ndrcSource, Object.assign({}, ndrcParsed, {
    deltas: { '92': -0.08, '95': -0.08, '98': -0.1, '0': -0.08 },
    perFuel: true,
    reviewStatus: 'approved'
  }));
  var upgraded = await dao.notices.findByDedupKey(ndrcKey);
  check('存疑的通知被更可信的解析覆盖（不新增一条）', !!upgraded && upgraded.id === pendingNotice.id,
    upgraded ? String(upgraded.id) : '无');
  check('覆盖后 reviewStatus 变 approved', upgraded && upgraded.reviewStatus === 'approved',
    upgraded && upgraded.reviewStatus);
  check('覆盖后幅度是逐项的', upgraded && upgraded.changes['98'] === -0.1,
    upgraded ? JSON.stringify(upgraded.changes) : '无');
  var publicAfterUpgrade = await dao.notices.listPublic('official', 50, 0);
  check('覆盖后这条对外可见',
    publicAfterUpgrade.some(function (n) { return n.dedupKey === ndrcKey; }));

  // 机器判定可信的前提：approved 的通知必须带执行日期，
  // 否则既没法倒计时也没法触发提醒。
  var approvedRows = await dao.notices.listPublic('official', 50, 0);
  var noDate = approvedRows.filter(function (n) { return !n.executeAt; });
  check('对外可见的通知都带执行日期', noDate.length === 0,
    noDate.map(function (n) { return n.title; }).join('、'));

  console.log('\n--- 启动期配置校验 ---');
  // P0-3：以前 start() 不校验任何配置，空密钥服务照常启动、照常签发 token。
  var configPath = require.resolve(path.join(ROOT, 'src', 'config.js'));
  function loadConfig(env) {
    Object.keys(env).forEach(function (k) {
      if (env[k] === null) delete process.env[k];
      else process.env[k] = env[k];
    });
    delete require.cache[configPath];
    return require(configPath);
  }
  var noSecret = loadConfig({ OIL_TOKEN_SECRET: '', DATABASE_URL: '' }).validate();
  check('缺 OIL_TOKEN_SECRET 时启动校验报错',
    noSecret.errors.some(function (e) { return e.indexOf('OIL_TOKEN_SECRET') >= 0; }),
    JSON.stringify(noSecret.errors));
  check('缺 DATABASE_URL 时启动校验报错',
    noSecret.errors.some(function (e) { return e.indexOf('DATABASE_URL') >= 0; }));
  var shortSecret = loadConfig({ OIL_TOKEN_SECRET: 'short', DATABASE_URL: 'postgres://x/y' }).validate();
  check('密钥太短时启动校验报错',
    shortSecret.errors.some(function (e) { return e.indexOf('OIL_TOKEN_SECRET') >= 0; }));
  var fullConfig = loadConfig({
    OIL_TOKEN_SECRET: 'a'.repeat(40),
    DATABASE_URL: 'postgres://x/y'
  });
  var fullCheck = fullConfig.validate();
  check('配置齐全时启动校验通过', fullCheck.errors.length === 0, JSON.stringify(fullCheck.errors));
  check('缺微信凭据只警告不阻断（登录不可用，但服务能起）',
    fullCheck.warnings.length > 0 && fullCheck.errors.length === 0);
  // 还原环境
  loadConfig({ OIL_TOKEN_SECRET: null, DATABASE_URL: null });

  console.log('\n--- 非法地区代码 ---');
  var queryService = require(path.join(ROOT, 'src', 'services', 'query.js'));
  var regionErr = null;
  try {
    queryService.resolveRegion('999999');
  } catch (e) {
    regionErr = e;
  }
  check('非法 regionCode 报 INVALID_REGION（不再静默回退上海）',
    !!regionErr && regionErr.code === 'INVALID_REGION');
  check('合法 regionCode 能查到地区', queryService.resolveRegion('440000').code === '440000');
  check('不传 regionCode 用默认地区', queryService.resolveRegion('').code === shared.DEFAULT_REGION_CODE);

  console.log('\n--- 写接口入参校验 ---');
  var userService = require(path.join(ROOT, 'src', 'services', 'user.js'));
  function expectCode(fn, code) {
    var err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    return !!err && err.code === code;
  }
  var manyRules = [];
  for (var ri = 0; ri < 60; ri++) manyRules.push({ regionCode: '440000', fuelId: '92' });
  check('规则条数超限被拒', expectCode(function () {
    userService.actionRulesSave('u-limit', manyRules);
  }, 'TOO_MANY_RULES'));
  check('非法地区代码的规则被拒', expectCode(function () {
    userService.actionRulesSave('u-region', [{ regionCode: '999999', fuelId: '92' }]);
  }, 'INVALID_REGION'));
  check('非法油品标号被拒', expectCode(function () {
    userService.actionRulesSave('u-fuel', [{ regionCode: '440000', fuelId: '95a' }]);
  }, 'INVALID_FUEL'));
  check('非法目标价被拒', expectCode(function () {
    userService.actionRulesSave('u-target', [{ regionCode: '440000', fuelId: '92', targetPrice: 'abc' }]);
  }, 'INVALID_TARGET_PRICE'));

  console.log('\n--- 去重键与发送去重 ---');
  await userService.actionHistorySave('u-prefix', [{ dedupKey: 'fake::key', sent: true }]);
  var prefixLogs = await dao.logs.listByUser('u-prefix', 50);
  check('客户端提交的去重键被强制加 local: 前缀（不能预占系统去重键）',
    prefixLogs.length > 0 && prefixLogs.every(function (l) {
      return l.dedupKey.indexOf('local:u-prefix:') === 0;
    }),
    prefixLogs.map(function (l) { return l.dedupKey; }).join('、'));

  var reserved = await dao.logs.reserve({ userId: 'u-dup', dedupKey: 'dup::key', payload: { type: 'test' } });
  check('占位成功返回记录', !!reserved && !!reserved.id);
  var reservedAgain = await dao.logs.reserve({ userId: 'u-dup', dedupKey: 'dup::key', payload: { type: 'test' } });
  check('同一个去重键第二次占不到（去重发生在副作用之前）', !reservedAgain);
  await dao.logs.markResult(reserved.id, true, null);
  var marked = await dao.logs.listByUser('u-dup', 50);
  check('占位后能回填发送结果', marked.length === 1 && marked[0].sent === true);

  console.log('\n--- 采集可信公告要补写调价节点 ---');
  var eventsAfterNotice = await dao.events.listAll();
  check('可信公告会同步补一条调价节点（走势页才有调价节点可显示）',
    eventsAfterNotice.some(function (e) { return e.date === '2026-11-24'; }),
    '现有日期：' + eventsAfterNotice.map(function (e) { return e.date; }).slice(-3).join('、'));

  console.log('\n--- 预测只存区间，不猜分油品幅度 ---');
  await collector.saveWindow(
    { id: 'test-window-src', name: '测试源' },
    { date: '2026-11-30', time: '24:00', direction: 'down', changeTon: null, literMin: 0.08, literMax: 0.1 }
  );
  var testWindow = await dao.windows.latestBySource('test-window-src');
  check('预测窗口存的是区间结构',
    !!testWindow.forecast && testWindow.forecast.literMin === 0.08 &&
    testWindow.forecast.literMax === 0.1 && testWindow.forecast.estimated === true,
    testWindow.forecast ? JSON.stringify(testWindow.forecast) : '无');
  check('预测窗口没有按油品复制的中值',
    testWindow.forecast && !testWindow.forecast['92'],
    testWindow.forecast ? JSON.stringify(testWindow.forecast) : '无');
  check('预测方向单独存着', testWindow.forecastDirection === 'down');

  console.log('\n--- 历史价：价格没变也要记当天挂牌价 ---');
  // 以前只在价格变化时写历史价，30 天没调价走势图就只剩起点的 1 个点，
  // 连一条横线都画不出来。现在每轮都写当天生效的挂牌价（按日期幂等覆盖）。
  var histRegion = { code: '990001', name: '测试省', city: '测试市' };
  var histSource = { id: 'test-hist-src', name: '测试源' };
  var histFuel = '92';
  var histPrice = 7.55;
  await dao.prices.upsertMany([{
    regionCode: histRegion.code,
    regionName: histRegion.name + ' · ' + histRegion.city,
    fuelId: histFuel,
    fuelName: '92号汽油',
    price: histPrice,
    changeAmount: 0.3,
    changeAt: '2026-11-01',
    source: histSource.id
  }]);
  var histExisting = {};
  histExisting[histRegion.code] = {};
  histExisting[histRegion.code][histFuel] = {
    regionCode: histRegion.code,
    fuelId: histFuel,
    price: histPrice,
    changeAmount: 0.3,
    changeAt: '2026-11-01',
    source: histSource.id
  };
  await collector.saveRegionPrices(histSource, histRegion, { prices: { '92': histPrice } }, histExisting);
  var histRows = await dao.history.listByRegionFuel(histRegion.code, histFuel, null);
  check('价格没变也记了当天挂牌价（走势线的横段靠它）', histRows.length === 1,
    '实际 ' + histRows.length + ' 行');
  var histPriceRow = (await dao.prices.listByRegion(histRegion.code))[0];
  check('价格没变就不改调价日', histPriceRow.changeAt === '2026-11-01', String(histPriceRow.changeAt));
  check('价格没变就不改调价幅度', histPriceRow.changeAmount === 0.3, String(histPriceRow.changeAmount));

  console.log('\n--- 订阅消息请求体：必须是 {value} 包装 ---');
  // ⚠️ 微信 message/subscribe/send 要求每个字段是 {"value": "..."} 对象。
  // 传扁平字符串平台一律拒收（errcode 47003）。
  // 上一轮两边「一致地」漏了包装：契约表按扁平值校验，自检也按扁平值断言，
  // 结果全绿但真发必失败。所以这里用**平台文档的固定夹具**交叉校验，
  // 而不是拿自己生成的契约表当标准。
  var subscribeTemplates = require(path.join(ROOT, 'src', 'services', 'subscribe-templates.js'));
  var subscribeService = require(path.join(ROOT, 'src', 'services', 'subscribe.js'));
  var alertService = require(path.join(ROOT, 'src', 'services', 'alert.js'));

  // 微信官方文档里的请求体样例：字段名与结构就是平台契约
  var WECHAT_FIXTURE = {
    touser: 'OPENID',
    template_id: 'TEMPLATE_ID',
    page: 'index',
    miniprogram_state: 'developer',
    lang: 'zh_CN',
    data: {
      thing1: { value: 'pancakes' },
      amount2: { value: '39.8元' },
      date3: { value: '2026年11月24日' },
      phrase4: { value: '微信支付' },
      thing5: { value: '微信支付' }
    }
  };

  var flat = alertService.buildData({
    fuel: '92# 汽油', amount: 0.13, direction: '下调', date: '2026-11-24', tip: '广东现价8.39元'
  });
  var body = subscribeService.buildBody({
    openid: 'OPENID',
    templateId: subscribeTemplates.PRIMARY_TEMPLATE_ID,
    page: 'pages/index/index',
    data: flat,
    miniprogramState: 'developer'
  });
  check('订阅消息 data 每个字段都是含 value 的对象',
    Object.keys(body.data).every(function (k) {
      var v = body.data[k];
      return v && typeof v === 'object' && !Array.isArray(v) && typeof v.value === 'string';
    }),
    JSON.stringify(body.data));
  check('订阅消息 data 的字段名都是模板占位符',
    Object.keys(body.data).every(function (k) {
      return !!subscribeTemplates.templateOf(subscribeTemplates.PRIMARY_TEMPLATE_ID).fields[k];
    }),
    Object.keys(body.data).join(','));
  check('订阅消息请求体顶层字段与平台夹具一致',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(Object.keys(WECHAT_FIXTURE).sort()),
    Object.keys(body).join(','));
  check('平台夹具里出现过的字段，我们的请求体也是同样的 {value: 字符串} 结构',
    Object.keys(WECHAT_FIXTURE.data).every(function (k) {
      var f = WECHAT_FIXTURE.data[k];
      var o = body.data[k];
      if (!o) return true;
      return f && typeof f === 'object' && typeof f.value === 'string' &&
        typeof o === 'object' && typeof o.value === 'string';
    }));

  // 真正发一次（把微信接口桩掉），抓**实际 POST 出去的 body** 来断言
  var authService = require(path.join(ROOT, 'src', 'services', 'auth.js'));
  var captured = null;
  var origCallWeChat = authService.callWeChat;
  authService.callWeChat = function (urlPath, query, post) {
    if (urlPath.indexOf('/cgi-bin/token') >= 0) {
      return Promise.resolve({ access_token: 'TEST_TOKEN', expires_in: 7200 });
    }
    if (urlPath.indexOf('subscribe/send') >= 0) {
      captured = post;
      return Promise.resolve({ errcode: 0, errmsg: 'ok' });
    }
    return origCallWeChat.apply(null, arguments);
  };
  await subscribeService.send({
    openid: 'OPENID',
    templateId: subscribeTemplates.PRIMARY_TEMPLATE_ID,
    page: 'pages/index/index',
    data: flat
  });
  authService.callWeChat = origCallWeChat;
  check('实际 POST 出去的 data 每个字段都是 {value: 字符串}',
    !!captured && Object.keys(captured.data).every(function (k) {
      var v = captured.data[k];
      return v && typeof v === 'object' && !Array.isArray(v) && typeof v.value === 'string';
    }),
    captured ? JSON.stringify(captured.data) : '没抓到请求体');
  check('实际 POST 出去的字段名与模板占位符一致',
    !!captured && Object.keys(captured.data).every(function (k) {
      return !!subscribeTemplates.templateOf(subscribeTemplates.PRIMARY_TEMPLATE_ID).fields[k];
    }),
    captured ? Object.keys(captured.data).join(',') : '');

  console.log('\n--- 公告入库 → 可信度判定 → 对外可见性（端到端） ---');
  // ⚠️ 不允许直接 insert 一条 approved 夹具 —— 那会绕过整条判定链路，
  // 自检就成了「自己证明自己」。这里从**正文**出发走完整条链路。
  var sources = require(path.join(ROOT, 'src', 'services', 'sources.js'));
  var noticeSource = { id: 'ndrc-notice', name: '国家发展改革委价格监测中心', url: 'https://example.invalid/' };
  var goodText = '根据国家发展改革委有关成品油价格调整的通知，自2026年12月10日24时起，' +
    '国内成品油价格按机制下调，调整幅度为：92号汽油每升下调0.08元，95号汽油每升下调0.08元，' +
    '98号汽油每升下调0.10元，0号柴油每升下调0.08元。';
  var parsedGood = sources.PARSERS.ndrcNotice(goodText);
  await collector.saveNotice(noticeSource, parsedGood);
  var goodKey = shared.dedupKey(noticeSource.id, parsedGood.title, parsedGood.executeAt);
  var rowGood = await dao.notices.findByDedupKey(goodKey);
  check('正文完整的公告入库后 review_status 是 approved',
    !!rowGood && rowGood.reviewStatus === 'approved', rowGood && rowGood.reviewStatus);
  var publicList = await dao.notices.listPublic('official', 50, 0);
  check('可信公告对外可见',
    !!rowGood && publicList.some(function (n) { return n.id === rowGood.id; }));

  // 只写了一个油品 —— 缺的两个是猜不出来的，不能发布
  var parsedBad = sources.PARSERS.ndrcNotice('自2026年12月20日24时起，92号汽油每升下调0.10元。');
  await collector.saveNotice(noticeSource, parsedBad);
  var badKey = shared.dedupKey(noticeSource.id, parsedBad.title, parsedBad.executeAt);
  var rowBad = await dao.notices.findByDedupKey(badKey);
  check('残缺公告入库后是 pending', !!rowBad && rowBad.reviewStatus === 'pending',
    rowBad && rowBad.reviewStatus);
  check('残缺公告不对外可见',
    !!rowBad && !(await dao.notices.listPublic('official', 50, 0)).some(function (n) { return n.id === rowBad.id; }));
  check('残缺公告的摘要不谎称「逐项列明各油品」',
    !!rowBad && rowBad.summary.indexOf('逐项列明') < 0, rowBad && rowBad.summary);

  console.log('\n--- 发送失败不再永久占住去重键 ---');
  var retryKey = 'selftest::retry::key';
  var reserved1 = await dao.logs.reserve({ userId: 'u1', dedupKey: retryKey, payload: { type: 'x' } });
  check('第一次能占到去重键', !!reserved1);
  var reserved2 = await dao.logs.reserve({ userId: 'u1', dedupKey: retryKey, payload: { type: 'x' } });
  check('同一个键第二次占不到（不会重复发）', !reserved2);
  await dao.logs.release(reserved1.id);
  var reserved3 = await dao.logs.reserve({ userId: 'u1', dedupKey: retryKey, payload: { type: 'x' } });
  check('可重试失败释放占位后还能再占（下一轮能重发）', !!reserved3);
  await dao.logs.markResult(reserved3.id, false, '45009:api freq out of limit');
  var hist1 = await dao.logs.listByUser('u1', 50);
  check('失败记录带原因时仍然出现在用户历史里',
    hist1.some(function (h) { return h.dedupKey === retryKey && !!h.failReason; }));

  // 崩在 reserve 与 markResult 之间的僵尸占位：历史里不显示，过期后能被回收
  await pgPool.query(
    'INSERT INTO alert_logs (user_id, dedup_key, time, sent, fail_reason, payload) ' +
    'VALUES ($1, $2, NOW(), FALSE, NULL, $3::jsonb)',
    ['u2', 'zombie::key', JSON.stringify({})]
  );
  var hist2 = await dao.logs.listByUser('u2', 50);
  check('没回填结果的僵尸占位不出现在用户历史里',
    !hist2.some(function (h) { return h.dedupKey === 'zombie::key'; }));
  await pgPool.query(
    'INSERT INTO alert_logs (user_id, dedup_key, time, sent, fail_reason, payload) ' +
    'VALUES ($1, $2, $3::timestamptz, FALSE, NULL, $4::jsonb)',
    ['u3', 'stale::key', new Date(Date.now() - 30 * 60 * 1000).toISOString(), JSON.stringify({})]
  );
  var staleTakeover = await dao.logs.reserve({ userId: 'u3', dedupKey: 'stale::key', payload: {} });
  check('崩在中途的过期占位能被回收重发', !!staleTakeover);

  check('网络类失败算可重试', alertService.classifyFailure('请求超时') === 'retryable');
  check('平台限流算可重试', alertService.classifyFailure('45009:api freq out of limit') === 'retryable');
  check('模板没配算不可重试', alertService.classifyFailure('TEMPLATE_NOT_CONFIGURED') === 'permanent');
  check('没有订阅额度算不可重试', alertService.classifyFailure('43101:user refuse') === 'permanent');

  console.log('\n--- 错误信息不对外透传内部细节 ---');
  var errorsModule = require(path.join(ROOT, 'src', 'errors.js'));
  var internal = errorsModule.publicError({ code: 'PG_ERROR', message: 'relation "oil_prices" does not exist' });
  check('内部错误不把 SQL 原文返回给客户端',
    internal.message.indexOf('oil_prices') < 0, internal.message);
  check('内部错误给稳定 code', internal.code === 'INTERNAL_ERROR');
  var known = errorsModule.publicError({ code: 'INVALID_REGION', message: 'whatever' });
  check('白名单里的业务错误透出友好文案', known.message === '地区代码不存在' && known.code === 'INVALID_REGION');

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
