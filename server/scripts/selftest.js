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

  // 模板 ID 三处同步：服务端契约表、小程序端 config、.env。
  // ⚠️ 模板 ID 手抄错一个字符（小写 l / 大写 I 长得一样）平台就拒收，
  // 日志里只写「参数无效」—— 所以这里钉死前两处必须一致。
  var miniConfig = require(path.join(ROOT, '..', 'config', 'index.js'));
  check('小程序端与服务端契约表用的是同一个模板 ID',
    miniConfig.subscribeTemplateIds[0] === templates.PRIMARY_TEMPLATE_ID,
    miniConfig.subscribeTemplateIds[0] + ' vs ' + templates.PRIMARY_TEMPLATE_ID);

  // .env 里配的模板 ID 没登记在契约表 → 回退契约表默认模板，
  // 不能拿一个平台不认的 ID 去发
  var configModule = require(path.join(ROOT, 'src', 'config.js'));
  var subscribeService = require(path.join(ROOT, 'src', 'services', 'subscribe.js'));
  var savedTemplateId = configModule.subscribeTemplateId;
  configModule.subscribeTemplateId = 'OaHgjTXIxhVAUOtdvqE_yxWZkt8r0cZdbhwuD4kq9Rqg';
  check('手抄错的模板 ID 会回退到契约表默认模板',
    subscribeService.templateId() === templates.PRIMARY_TEMPLATE_ID,
    subscribeService.templateId());
  configModule.subscribeTemplateId = savedTemplateId;

  console.log('\n--- 三类提醒的模板取值 ---');
  var tHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92',
      officialDrop: true, targetEnabled: true, targetPrice: 7.5, forecastDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
    { kind: 'official', executeAt: '2026-11-24', changes: { '92': -0.08 } },
    // 预测是**整轮区间**（来源不给分油品幅度），不是分油品的每升值
    { kind: 'forecast', executeAt: '2026-11-26', direction: 'down', literMin: 0.06, literMax: 0.08 }
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
      hitByType.forecastDrop.data.thing4.indexOf('非官方') > 0,
      hitByType.forecastDrop.data.thing4);
    check('预测下调的温馨提示带整轮区间',
      hitByType.forecastDrop.data.thing4.indexOf('0.06-0.08') > 0,
      hitByType.forecastDrop.data.thing4);
    check('预测下调的金额取来源给的区间下界（不编中值）',
      hitByType.forecastDrop.data.amount2 === '0.06元',
      hitByType.forecastDrop.data.amount2);
  }

  console.log('\n--- 官方降价提醒：公告只给吨价时的口径 ---');
  // ⚠️ 发改委公告入库时 changes 是空的（公告只给汽/柴油吨价）——
  // 以前这里读 changes[fuelId]，命中数恒为 0，官方降价提醒从来没触发过。
  var ndrcHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down',
      tonChanges: { gasoline: -645, diesel: -625 }, changes: {} },
    null,
    { localAmount: { before: 8.91, after: 8.39, delta: -0.52 } }
  );
  check('官方公告只有方向与吨价时也能命中（changes 为空）',
    ndrcHits.some(function (h) { return h.type === 'officialDrop'; }),
    JSON.stringify(ndrcHits));
  check('官方降价的金额取本地区实测差值',
    ndrcHits.length && ndrcHits[0].data.amount2 === '0.52元',
    ndrcHits.length ? ndrcHits[0].data.amount2 : '没命中');
  check('官方降价的温馨提示标明是本地区实测',
    ndrcHits.length && ndrcHits[0].data.thing4.indexOf('本地区实测') > 0,
    ndrcHits.length ? ndrcHits[0].data.thing4 : '');

  var medianHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down',
      tonChanges: { gasoline: -645, diesel: -625 }, changes: {} },
    null,
    { medianAmounts: { '92': -0.52 } }
  );
  check('没有本地区快照时用各省中位数，并标明是测算',
    medianHits.length && medianHits[0].data.thing4.indexOf('测算') > 0,
    medianHits.length ? medianHits[0].data.thing4 : '没命中');

  check('官方上调不算降价提醒', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'up',
      tonChanges: { gasoline: 645, diesel: 625 }, changes: {} },
    null,
    { medianAmounts: { '92': 0.52 } }
  ).length === 0);

  console.log('\n--- 预测提醒的数据入口：调价窗口 ---');
  // 预测源只写 oil_windows，从不写 kind='forecast' 的通知 ——
  // 以前去通知表里取最新预测，永远取不到，预测提醒在生产上没有入口。
  var winForecast = alert.forecastOf(
    { date: '2026-11-26', forecastDirection: 'down',
      forecast: { direction: 'down', literMin: 0.08, literMax: 0.1, estimated: true } },
    '2026-11-18');
  check('预测提醒能从调价窗口里取出方向与区间',
    !!winForecast && winForecast.direction === 'down' &&
    winForecast.literMin === 0.08 && winForecast.literMax === 0.1,
    JSON.stringify(winForecast));
  check('已经过去的窗口不产生预测提醒（预测早就失效了）',
    alert.forecastOf(
      { date: '2026-11-10', forecastDirection: 'down', forecast: { direction: 'down' } },
      '2026-11-18') === null);
  check('窗口没有预测方向时不产生预测提醒',
    alert.forecastOf({ date: '2026-11-26', forecast: {} }, '2026-11-18') === null);
  check('预测提醒开关关掉时不命中', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', forecastDrop: false },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    null,
    { kind: 'forecast', executeAt: '2026-11-26', direction: 'down', literMin: 0.08, literMax: 0.1 }
  ).length === 0);

  console.log('\n--- 新规则不命中旧公告 ---');
  var armedToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  check('规则生效前的旧公告不再触发提醒', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true, armedAt: armedToday },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-01', direction: 'down', changes: { '92': -0.08 } },
    null
  ).length === 0);
  check('规则生效后的新公告照常触发', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true, armedAt: armedToday },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2099-01-01', direction: 'down', changes: { '92': -0.08 } },
    null
  ).length === 1);
  check('没有 armedAt 的老规则不受限制', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-01', direction: 'down', changes: { '92': -0.08 } },
    null
  ).length === 1);

  console.log('\n--- 目标价区间前后端一致 ---');
  check('小程序端与服务端的目标价区间一致',
    miniConfig.targetPriceMin === configModule.targetPriceMin &&
    miniConfig.targetPriceMax === configModule.targetPriceMax,
    miniConfig.targetPriceMin + '-' + miniConfig.targetPriceMax + ' vs ' +
    configModule.targetPriceMin + '-' + configModule.targetPriceMax);
  check('超出区间的目标价被服务端拒绝', expectCode(function () {
    user.actionRulesSave('u-range', [{
      regionCode: '440000', fuelId: '92', targetPrice: configModule.targetPriceMax + 1
    }]);
  }, 'INVALID_TARGET_PRICE'));
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

  console.log('\n--- 本地区前后快照：通知详情不再用当前价倒推 ---');
  // ⚠️ 通知详情原来用「当前价 - 幅度」倒推调价前的价格：
  // 当前价可能已经是好几轮之后的价格，倒推出来的数谁都对不上账。
  // 现在从本地区的历史挂牌价里找这一轮前后的快照。
  var measureService = require(path.join(ROOT, 'src', 'services', 'measure.js'));
  var snapshot = await measureService.localSnapshotOf('440000', '92', '2026-11-10');
  check('本地区快照能给出调价前后的价',
    !!snapshot && typeof snapshot.before === 'number' && typeof snapshot.after === 'number',
    JSON.stringify(snapshot));
  check('本地区快照的差值就是前后价的差',
    !!snapshot && Math.abs((snapshot.after - snapshot.before) - snapshot.delta) < 0.001,
    JSON.stringify(snapshot));
  check('本地区快照找不到时给 null（不倒推、不编数）',
    (await measureService.localSnapshotOf('440000', '92', '2099-01-01')) === null);
  var snapshots = await measureService.localSnapshotsOf(['2026-11-10'], '440000');
  check('按生效日一次取多个油品的快照',
    !!snapshots['2026-11-10'] && !!snapshots['2026-11-10']['92'],
    JSON.stringify(snapshots));

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

  console.log('\n--- 价格行的调价基线：换源不能把「上次调价」清空 ---');
  // 换源那一轮同源基线取不到，原来会把 changeAt 清空 →
  // 首页四个油品全变成「暂无调价对比」，一直持续到下一次真调价（可能好几周）。
  // 现在：库里没基线时，从**本源自己的历史表**重建最近一次调价。
  var blSource = { id: 'test-bl-src', name: '基线源' };
  var blRegion = { code: '990010', name: '基线省', city: '基线市' };
  var blParsed = {
    prices: { '92': 8.39, '95': 9.09, '98': 11.09, '0': 8.06 },
    history: [
      { date: '2026-10-30', prices: { '92': 8.91, '95': 9.64, '98': 11.64, '0': 8.6 } },
      { date: '2026-11-13', prices: { '92': 8.39, '95': 9.09, '98': 11.09, '0': 8.06 } }
    ]
  };
  var blSave = async function (existing) {
    await collector.saveRegionPrices(blSource, blRegion, blParsed, existing || {});
    var rows = await dao.prices.listByRegion(blRegion.code);
    return rows.filter(function (p) { return p.fuelId === '92'; })[0];
  };

  var bl1 = await blSave({ '990010': { '92': { price: 8.39, changeAmount: 0, changeAt: null, source: 'test-old-src' } } });
  check('换源且价格没变：从本源历史表重建最近一次调价幅度', bl1 && Number(bl1.changeAmount) === -0.52,
    bl1 ? String(bl1.changeAmount) : '没写进去');
  check('换源且价格没变：重建出调价日', bl1 && bl1.changeAt === '2026-11-13', bl1 ? String(bl1.changeAt) : '');

  var bl2 = await blSave({ '990010': { '92': { price: 8.39, changeAmount: -0.52, changeAt: '2026-11-12', source: 'test-old-src' } } });
  check('换源且价格没变：库里已有基线就原样留着', bl2 && bl2.changeAt === '2026-11-12' && Number(bl2.changeAmount) === -0.52,
    bl2 ? (bl2.changeAt + ' / ' + bl2.changeAmount) : '');

  var bl3 = await blSave({ '990010': { '92': { price: 9.5, changeAmount: 0.2, changeAt: '2026-10-01', source: 'test-old-src' } } });
  check('换源且价格不一样：不凭空造一次调价', bl3 && !bl3.changeAt && Number(bl3.changeAmount) === 0,
    bl3 ? (bl3.changeAt + ' / ' + bl3.changeAmount) : '');

  var bl4 = await blSave({});
  check('首次采集：没有基线就留空（界面显示「暂无调价对比」）', bl4 && !bl4.changeAt && Number(bl4.changeAmount) === 0,
    bl4 ? (bl4.changeAt + ' / ' + bl4.changeAmount) : '');

  console.log('\n--- 历史价入库的五道闸门 ---');
  // 历史是**一次性回填**的（库里没有旧值可比），所以不能用「与上次采集价落差」
  // 那套逻辑，得单独设闸门。这组用例用构造数据把 5 道闸门逐条钉住。
  var gateSource = { id: 'test-gate-src', name: '测试源' };
  var gateRegion = { code: '990002', name: '闸门省', city: '闸门市' };
  var outlierRegion = { code: '990007', name: '离群省', city: '离群市' };
  var GDATES = ['2026-01-01', '2026-01-15', '2026-02-01'];

  function mkParsed(base, deltas) {
    var rows = [];
    var p = base;
    GDATES.forEach(function (d, i) {
      if (i > 0) p = Math.round((p + deltas[i]) * 100) / 100;
      rows.push({
        date: d,
        prices: {
          '92': p,
          '95': Math.round((p + 1) * 100) / 100,
          '98': Math.round((p + 2) * 100) / 100,
          '0': Math.round((p + 0.5) * 100) / 100
        },
        changes: {}
      });
    });
    // 当前价要与历史末行一致（首尾自洽），这里给一份**拷贝**，
    // 免得改当前价时把历史末行也一起改了，测不出不自洽的情况。
    return { prices: Object.assign({}, rows[rows.length - 1].prices), changes: {}, history: rows };
  }

  var goodParsed = mkParsed(8, [0, -0.5, -0.5]);
  var outlierParsed = mkParsed(8, [0, 0.5, -0.5]);

  // 跨省统计要够多的省才成立（实测是 31 省，阈值取 5）
  var statSeries = {};
  ['990002', '990003', '990004', '990005', '990006'].forEach(function (code) {
    statSeries[code] = collector.historySeries(goodParsed);
  });
  statSeries[outlierRegion.code] = collector.historySeries(outlierParsed);
  var gateStats = collector.crossProvinceStats(statSeries);

  // G1 区间：价格超合理区间的点丢掉
  var overParsed = mkParsed(8, [0, -0.5, -0.5]);
  overParsed.history[1].prices['92'] = 99;
  var g1 = await collector.saveHistory(gateSource, gateRegion, overParsed, gateStats);
  check('G1 价格超区间：丢点', g1.dropped.some(function (d) { return d.reason === 'PRICE_OUT_OF_RANGE'; }),
    JSON.stringify(g1.dropped));
  check('G1 价格超区间：该点没入库（3 期 × 4 油品 - 1 = 11 行）', g1.saved === 11, '实际 ' + g1.saved + ' 行');

  // G2/G5 同日期重复：只留一行
  var dupParsed = mkParsed(8, [0, -0.5, -0.5]);
  dupParsed.history.push({ date: GDATES[2], prices: dupParsed.history[2].prices, changes: {} });
  var g2 = await collector.saveHistory(gateSource, gateRegion, dupParsed, gateStats);
  check('G2 同日期重复：丢重复行', g2.dropped.some(function (d) { return d.reason === 'DUPLICATE_DATE'; }),
    JSON.stringify(g2.dropped));
  check('G2 同日期重复：入库仍是 12 行', g2.saved === 12, '实际 ' + g2.saved + ' 行');

  // G3 首尾自洽：历史末行 ≠ 同页现价 → 整省历史丢弃
  var mismatchParsed = mkParsed(8, [0, -0.5, -0.5]);
  mismatchParsed.prices['92'] = 7.77;
  var g3 = await collector.saveHistory(gateSource, gateRegion, mismatchParsed, gateStats);
  check('G3 首尾自洽不符：整省历史丢弃', g3.saved === 0 && g3.skipped === 'PRICE_MISMATCH',
    'saved=' + g3.saved + ' skipped=' + g3.skipped);
  check('G3 首尾自洽不符：记告警', g3.advisories.some(function (a) {
    return a.reason === 'HISTORY_PRICE_MISMATCH';
  }));

  // G4 跨省一致性：离群省要告警，但**保留源站原值**
  var g4 = await collector.saveHistory(gateSource, outlierRegion, outlierParsed, gateStats);
  check('G4 跨省离群：记告警', g4.advisories.some(function (a) {
    return a.reason === 'CROSS_PROVINCE_DEVIATION';
  }), JSON.stringify(g4.advisories));
  check('G4 跨省离群：保留源站原值（只告警，不擅自改写）', g4.saved === 12, '实际 ' + g4.saved + ' 行');

  // 调价节点推导：全年节点靠它
  var deriveSeries = {};
  ['990002', '990003', '990004', '990005', '990006'].forEach(function (code) {
    deriveSeries[code] = collector.historySeries(goodParsed);
  });
  var deriveEvents = collector.deriveAdjustEvents(deriveSeries);
  check('调价节点推导：两轮调价各一个节点', deriveEvents.length === 2, '实际 ' + deriveEvents.length + ' 个');
  check('调价节点推导：幅度取跨省中位数', deriveEvents.length === 2 && deriveEvents[1].deltas['92'] === -0.5,
    JSON.stringify(deriveEvents.map(function (e) { return e.deltas; })));

  console.log('\n--- 走势页调价节点：官方公告与历史推导要合并（不是二选一） ---');
  // 以前是二选一：officialEvents.length ? 官方 : 推导。
  // 官方公告只覆盖最近几轮 → 一年视图只有几个节点，其余全空。
  var trendToday = query.todayStr();
  var trendFrom = new Date(new Date(trendToday + 'T00:00:00Z').getTime() - 12 * 30 * 86400000)
    .toISOString().slice(0, 10);
  var inRange = function (d) { return d && d >= trendFrom && d <= trendToday; };
  var trend1y = await query.actionTrend({ regionCode: '440000', fuelId: '92', period: '1y' });
  var trendDates = {};
  trend1y.events.forEach(function (e) { trendDates[e.date] = true; });
  var seedEventDates = (await dao.events.listAll())
    .map(function (e) { return e.date; })
    .filter(inRange);
  var noticeDates = (await dao.notices.listPublic('official', 60, 0))
    .map(function (n) { return n.executeAt; })
    .filter(inRange);
  // ⚠️ 推导节点可能被**邻日的官方节点收编**：同一次调价，公告写「X日24时起」，
  // 挂牌价次日 00:00 生效 —— 官方节点是 X，推导节点是 X+1。
  // 这时推导节点不再单独出现（那一次调价由官方节点代表），不算「丢节点」。
  var dayDiff = function (a, b) {
    var ta = Date.parse(a + 'T00:00:00Z');
    var tb = Date.parse(b + 'T00:00:00Z');
    if (!isFinite(ta) || !isFinite(tb)) return 9999;
    return Math.round((ta - tb) / 86400000);
  };
  var absorbedSeed = seedEventDates.filter(function (d) {
    if (trendDates[d]) return false;
    return noticeDates.some(function (nd) { return Math.abs(dayDiff(nd, d)) === 1; });
  });
  var missingSeed = seedEventDates.filter(function (d) {
    return !trendDates[d] && absorbedSeed.indexOf(d) < 0;
  });
  var missingNotice = noticeDates.filter(function (d) { return !trendDates[d]; });
  check('trend 1y：历史推导的节点一个不少（被邻日官方节点收编的不算丢）', missingSeed.length === 0,
    '推导 ' + seedEventDates.length + ' 个，收编 ' + absorbedSeed.length + ' 个，缺 ' + JSON.stringify(missingSeed.slice(0, 5)));
  check('trend 1y：官方公告的节点都在', missingNotice.length === 0,
    '官方 ' + noticeDates.length + ' 个，缺 ' + JSON.stringify(missingNotice.slice(0, 5)));
  check('trend 1y：节点是两者并集（二选一的话会少一半）',
    trend1y.events.length >= Math.max(seedEventDates.length, noticeDates.length),
    '节点数 ' + trend1y.events.length + '，推导 ' + seedEventDates.length + '，官方 ' + noticeDates.length);
  check('trend 1y：节点日期不重复', Object.keys(trendDates).length === trend1y.events.length,
    '去重后 ' + Object.keys(trendDates).length + '，总数 ' + trend1y.events.length);
  check('trend 1y：source.note 如实写来源与覆盖范围',
    typeof trend1y.source.note === 'string' && trend1y.source.note.indexOf('历史价来自') >= 0,
    String(trend1y.source.note));

  console.log('\n--- 首页卡片：价格行没基线时用历史序列补 ---');
  // 换源那一轮同源基线取不到 → changeAt 被清空 →
  // 首页四个油品全变成「暂无调价对比」。采集器已改成从本源历史表重建，
  // 但采集有 6 小时新鲜期，最长要等下一轮真抓才生效 —— 读侧再兜一层。
  var laRows = [
    { fuelId: '92', date: '2026-10-30', price: 8.91 },
    { fuelId: '92', date: '2026-11-13', price: 8.39 },
    { fuelId: '95', date: '2026-11-13', price: 9.64 }
  ];
  var la = query.lastAdjustmentOf(laRows, '92');
  check('lastAdjustmentOf：算出最近一次调价的幅度与日期', la && la.amount === -0.52 && la.date === '2026-11-13',
    JSON.stringify(la));
  check('lastAdjustmentOf：没有变化时给 null',
    query.lastAdjustmentOf([{ fuelId: '92', date: '2026-11-13', price: 8.39 }], '92') === null);
  check('lastAdjustmentOf：不串别的油品',
    query.lastAdjustmentOf([{ fuelId: '95', date: '2026-11-13', price: 9.09 }], '92') === null);

  // 集成：抹掉一个地区的价格行基线，首页卡片应该用历史序列补回来
  var blHomeRegion = '510000';
  var blHomeRows = await dao.prices.listByRegion(blHomeRegion);
  var blHomeBackup = blHomeRows.map(function (p) {
    return { regionCode: p.regionCode, regionName: p.regionName, fuelId: p.fuelId, fuelName: p.fuelName,
      price: p.price, changeAmount: p.changeAmount, changeAt: p.changeAt, source: p.source };
  });
  await dao.prices.upsertMany(blHomeBackup.map(function (p) {
    return { regionCode: p.regionCode, regionName: p.regionName, fuelId: p.fuelId, fuelName: p.fuelName,
      price: p.price, changeAmount: 0, changeAt: null, source: p.source };
  }));
  var homeBl = await query.actionHome({ regionCode: blHomeRegion });
  var cardBl = (homeBl.prices || []).filter(function (p) { return p.id === '92'; })[0];
  check('首页卡片：价格行没基线时补出调价日', cardBl && !!cardBl.changeAt, JSON.stringify(cardBl));
  var expectBl = query.lastAdjustmentOf(await dao.history.listByRegion(blHomeRegion), '92');
  check('首页卡片：补出来的幅度与历史序列一致',
    cardBl && expectBl && Number(cardBl.changeAmount) === expectBl.amount,
    JSON.stringify({ card: cardBl && cardBl.changeAmount, expect: expectBl && expectBl.amount }));
  await dao.prices.upsertMany(blHomeBackup);

  console.log('\n--- 同一次调价：官方日期与挂牌价生效日差一天，要合成一个节点 ---');
  // 公告写「11月12日24时起」→ 官方节点 11-12；挂牌价次日 00:00 生效 → 推导节点 11-13。
  // 只按精确日期合并的话，同一次调价会被数成两次：节点列表挨着出现两条，
  // 调价次数也多算一次（线上实测 26 个节点里实际只有 23 次调价）。
  var merge = query.mergeAdjustNodes;
  var derivedOne = [{ date: '2026-11-13', title: '国内成品油价格调整', amount: -0.52, amountKnown: true, direction: 'down', measured: true }];
  var officialOne = [{ date: '2026-11-12', title: '2026年11月12日国内成品油价格调整', amount: -0.52, amountKnown: true, direction: 'down' }];

  var m1 = merge(derivedOne, officialOne);
  check('邻日的官方节点与推导节点合成一个', m1.length === 1, '实际 ' + m1.length + ' 个');
  check('合成后保留官方日期', m1.length === 1 && m1[0].date === '2026-11-12',
    JSON.stringify(m1.map(function (e) { return e.date; })));
  check('合成后保留官方标题', m1.length === 1 && m1[0].title.indexOf('2026年11月12日') >= 0,
    m1.length ? m1[0].title : '');
  check('合成后幅度取官方值', m1.length === 1 && m1[0].amount === -0.52, m1.length ? String(m1[0].amount) : '');

  var m2 = merge(derivedOne, [{ date: '2026-11-12', title: '官方', amount: null, amountKnown: false, direction: 'down' }]);
  check('官方测不出幅度时用邻日推导值兜底', m2.length === 1 && m2[0].amountKnown === true && m2[0].amount === -0.52,
    JSON.stringify(m2));

  var m3 = merge(
    derivedOne.concat([{ date: '2026-12-10', title: '推导', amount: 0.2, amountKnown: true, direction: 'up', measured: true }]),
    officialOne
  );
  check('离得远的推导节点不被误并', m3.length === 2,
    '实际 ' + m3.length + ' 个：' + JSON.stringify(m3.map(function (e) { return e.date; })));

  var m4 = merge(
    [{ date: '2026-11-10', title: '推导', amount: 0.2, amountKnown: true, direction: 'up', measured: true }],
    officialOne
  );
  check('差两天的推导节点不被误并', m4.length === 2,
    '实际 ' + m4.length + ' 个：' + JSON.stringify(m4.map(function (e) { return e.date; })));

  var m5 = merge(
    [{ date: '2026-11-12', title: '推导', amount: -0.52, amountKnown: true, direction: 'down', measured: true }],
    officialOne
  );
  check('同日的官方节点直接覆盖推导节点', m5.length === 1 && m5[0].title.indexOf('2026年11月12日') >= 0,
    JSON.stringify(m5));

  var m6 = merge(
    derivedOne,
    [
      { date: '2026-11-12', title: '官方A', amount: -0.52, amountKnown: true, direction: 'down' },
      { date: '2026-11-13', title: '官方B', amount: -0.52, amountKnown: true, direction: 'down' }
    ]
  );
  check('官方节点不许收编别的官方节点', m6.length === 2,
    '实际 ' + m6.length + ' 个：' + JSON.stringify(m6.map(function (e) { return e.date; })));

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
  var noticeSource = { id: 'ndrc-notice', name: '国家发展改革委价格司', url: 'https://example.invalid/' };
  // ⚠ 发改委公告只给吨价、只分汽/柴油两类，**不给**每升四油品幅度。
  // 这里按真实公告的形态拼正文，不再假设「92号汽油每升下调0.08元」那种写法。
  var ndrcHtml = function (body, title, pubDate) {
    return '<html><head>' +
      '<meta name="ArticleTitle" content="' + title + '">' +
      '<meta name="PubDate" content="' + pubDate + '">' +
      '</head><body><div class="article"><div class="article_l">' +
      '<div class="article_con article_con_title"><div class=TRS_Editor><div>' + body + '</div></div></div>' +
      '</div><div class="article_r"></div></div></body></html>';
  };
  var goodText = ndrcHtml(
    '根据国际市场油价变化情况，自12月10日24时起，国内汽、柴油（标准品）价格每吨分别下调645元、625元。',
    '2026年12月10日国内成品油价格调整',
    '2026-12-10 10:00:00'
  );
  var parsedGood = sources.PARSERS.ndrcNotice(goodText);
  await collector.saveNotice(noticeSource, parsedGood);
  var goodKey = shared.dedupKey(noticeSource.id, parsedGood.title, parsedGood.executeAt);
  var rowGood = await dao.notices.findByDedupKey(goodKey);
  check('正文完整的公告入库后 review_status 是 approved',
    !!rowGood && rowGood.reviewStatus === 'approved', rowGood && rowGood.reviewStatus);
  check('官方吨价入库了（汽/柴油，元/吨）',
    !!rowGood && rowGood.tonChanges && rowGood.tonChanges.gasoline === -645 &&
    rowGood.tonChanges.diesel === -625, rowGood && JSON.stringify(rowGood.tonChanges));
  check('官方方向入库了', !!rowGood && rowGood.direction === 'down', rowGood && rowGood.direction);
  check('公告发布日期入库了', !!rowGood && rowGood.announcedAt === '2026-12-10', rowGood && rowGood.announcedAt);
  check('公告的每升四油品幅度留空（公告不给这一项）',
    !!rowGood && Object.keys(rowGood.changes || {}).length === 0, rowGood && JSON.stringify(rowGood.changes));
  check('可信公告的摘要说的是吨价',
    !!rowGood && rowGood.summary.indexOf('元/吨') >= 0, rowGood && rowGood.summary);
  var publicList = await dao.notices.listPublic('official', 50, 0);
  check('可信公告对外可见',
    !!rowGood && publicList.some(function (n) { return n.id === rowGood.id; }));

  // 方向解析不出来 —— 替来源猜方向就是编结论，不能发布
  var parsedBad = sources.PARSERS.ndrcNotice(ndrcHtml(
    '根据国际市场油价变化情况，国内汽、柴油价格适当调整。',
    '2026年12月20日国内成品油价格适当调整',
    '2026-12-20 10:00:00'
  ));
  await collector.saveNotice(noticeSource, parsedBad);
  var badKey = shared.dedupKey(noticeSource.id, parsedBad.title, parsedBad.executeAt);
  var rowBad = await dao.notices.findByDedupKey(badKey);
  check('方向不明的公告入库后是 pending', !!rowBad && rowBad.reviewStatus === 'pending',
    rowBad && rowBad.reviewStatus);
  check('存疑公告不对外可见',
    !!rowBad && !(await dao.notices.listPublic('official', 50, 0)).some(function (n) { return n.id === rowBad.id; }));
  check('存疑公告的摘要不谎称每升幅度',
    !!rowBad && rowBad.summary.indexOf('元/升') < 0, rowBad && rowBad.summary);

  console.log('\n--- 挂牌价测算：每升四油品幅度（端到端） ---');
  var measure = require(path.join(ROOT, 'src', 'services', 'measure.js'));
  // 灌一段挂牌价快照：生效日之前是旧价，生效日之后是新价
  var pushHistory = async function (rows) {
    await dao.history.upsertMany(rows);
  };
  var buildRows = function (regionList, pairs) {
    var rows = [];
    regionList.forEach(function (r) {
      shared.FUELS.forEach(function (fuel) {
        pairs.forEach(function (p) {
          rows.push({ regionCode: r.code, fuelId: fuel.id, date: p[0], price: p[1], source: 'qiyoujiage' });
        });
      });
    });
    return rows;
  };
  // 常规：生效日 2027-03-10，次日挂出新价（8.99 → 8.86）
  await pushHistory(buildRows(shared.REGIONS, [
    ['2027-03-09', 8.99], ['2027-03-10', 8.99], ['2027-03-11', 8.86]
  ]));
  var measured = await measure.measureOne('2027-03-10');
  check('四油品幅度都测算出来了',
    shared.FUELS.every(function (f) { return typeof measured[f.id] === 'number'; }),
    JSON.stringify(measured));
  check('测算出的方向是下调',
    measured['92'] < 0 && measured['0'] < 0, JSON.stringify(measured));
  check('测算幅度就是前后快照的差值',
    Math.abs(measured['92'] - (8.86 - 8.99)) < 0.0001, JSON.stringify(measured));

  // 来源站提前挂价：变价发生在生效日当天，也要算对
  await pushHistory(buildRows(shared.REGIONS, [
    ['2027-06-09', 9.50], ['2027-06-10', 9.37], ['2027-06-11', 9.37]
  ]));
  var measuredEarly = await measure.measureOne('2027-06-10');
  check('站点提前挂出新价时幅度照样算得对',
    Math.abs(measuredEarly['92'] - (9.37 - 9.50)) < 0.0001, JSON.stringify(measuredEarly));

  // 样本太少：中位数不可信，不给结论
  await pushHistory(buildRows([shared.REGIONS[0]], [
    ['2027-09-09', 8.00], ['2027-09-10', 8.00], ['2027-09-11', 7.87]
  ]));
  var measuredThin = await measure.measureOne('2027-09-10');
  check('样本太少时不给结论',
    Object.keys(measuredThin).length === 0, JSON.stringify(measuredThin));

  // 大轮调价：官方 645 元/吨 ≈ 0.47 元/升，真实挂牌价降幅 0.52~0.56 元/升。
  // ⚠️ 阈值早先写死 0.5 —— 这轮会被整轮剔光，界面一个每升幅度都出不来。
  await pushHistory(buildRows(shared.REGIONS, [
    ['2027-12-09', 8.91], ['2027-12-10', 8.91], ['2027-12-11', 8.39]
  ]));
  var measuredBig = await measure.measureOne('2027-12-10', { gasoline: -645, diesel: -625 });
  check('大轮调价（官方 645 元/吨）照样算得出每升幅度',
    Math.abs(measuredBig['92'] - (-0.52)) < 0.0001, JSON.stringify(measuredBig));
  check('大轮调价时柴油同样算得出',
    Math.abs(measuredBig['0'] - (-0.52)) < 0.0001, JSON.stringify(measuredBig));

  // 超出官方吨价能解释的范围 → 脏数据，不采信
  await pushHistory(buildRows(shared.REGIONS, [
    ['2028-01-09', 8.91], ['2028-01-10', 8.91], ['2028-01-11', 7.94]
  ]));
  var measuredDirty = await measure.measureOne('2028-01-10', { gasoline: -645, diesel: -625 });
  check('超出官方吨价范围的降幅不采信',
    Object.keys(measuredDirty).length === 0, JSON.stringify(measuredDirty));

  // 官方说降了不少、实测几乎没动 → 抓错快照，不采信
  await pushHistory(buildRows(shared.REGIONS, [
    ['2028-02-09', 8.91], ['2028-02-10', 8.91], ['2028-02-11', 8.86]
  ]));
  var measuredTiny = await measure.measureOne('2028-02-10', { gasoline: -645, diesel: -625 });
  check('与官方吨价明显不符的降幅不采信',
    Object.keys(measuredTiny).length === 0, JSON.stringify(measuredTiny));

  // 跨省离散：各省的值都在官方吨价能解释的区间里，但彼此差很多
  // → 中位数也不可信，这个油品不摆数值
  await pushHistory(buildRows(shared.REGIONS, [
    ['2028-03-09', 8.91], ['2028-03-10', 8.91], ['2028-03-11', 8.44]
  ]));
  await pushHistory(buildRows(shared.REGIONS.slice(0, 10), [
    ['2028-03-09', 8.91], ['2028-03-10', 8.91], ['2028-03-11', 8.60]
  ]));
  await pushHistory(buildRows(shared.REGIONS.slice(10, 20), [
    ['2028-03-09', 8.91], ['2028-03-10', 8.91], ['2028-03-11', 8.28]
  ]));
  var measuredScatter = await measure.measureOne('2028-03-10', { gasoline: -645, diesel: -625 });
  check('各省数据离散时该油品不摆测算值',
    measuredScatter['92'] === undefined, JSON.stringify(measuredScatter));

  // 对照：有多数支撑的中位数不该被误伤
  await pushHistory(buildRows(shared.REGIONS, [
    ['2028-04-09', 8.91], ['2028-04-10', 8.91], ['2028-04-11', 8.44]
  ]));
  await pushHistory(buildRows(shared.REGIONS.slice(0, 11), [
    ['2028-04-09', 8.91], ['2028-04-10', 8.91], ['2028-04-11', 8.60]
  ]));
  var measuredTight = await measure.measureOne('2028-04-10', { gasoline: -645, diesel: -625 });
  check('各省基本一致时不误伤（多数支撑的中位数照常给出）',
    Math.abs(measuredTight['92'] - (-0.47)) < 0.0001, JSON.stringify(measuredTight));

  // 官方吨价折算出的理论每升幅度（标准品：89 号汽油 0.725、0 号柴油 0.835）
  check('645 元/吨折成每升约 0.47 元',
    Math.abs(measure.boundOf(-645, 'gasoline').theo - 0.47) < 0.005,
    JSON.stringify(measure.boundOf(-645, 'gasoline')));
  check('625 元/吨折成每升约 0.52 元',
    Math.abs(measure.boundOf(-625, 'diesel').theo - 0.52) < 0.005,
    JSON.stringify(measure.boundOf(-625, 'diesel')));

  check('方向矛盾时不摆测算值', !measure.agreesWithDirection(measured, 'up'), '');
  check('方向一致时摆测算值', measure.agreesWithDirection(measured, 'down'), '');

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
