/**
 * 端到端自检：用 pg-mem 起一个内存 PostgreSQL，
 * 真建表、真灌数据、真调接口，验证返回结构符合小程序端的期望。
 *
 * 为什么用 pg-mem 而不是真库：
 *   本机不一定装了 PostgreSQL，而这个项目最需要守住的不是「能连上库」，
 *   而是「返回结构对不对」—— 结构不对前端会 reject，页面显示失败态，
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

  // 灌测试数据（测试夹具，不在生产代码里）
  console.log('\n--- 灌测试数据 ---');
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
  // ⚠️ quoteTime 是 'MM-DD HH:mm:ss'（缺年份）：Date.parse 会把它补成 2001 年，
  //    「现在 - 报价时刻」算出来是 1300 多万分钟（≈25 年），
  //    线上接口实际吐过 delayMinutes=13148652。这条钉住解析口径。
  check('market 延时分钟数在合理范围（不是几千万分钟）',
    market.delayMinutes === null ||
    (typeof market.delayMinutes === 'number' &&
      market.delayMinutes >= 0 && market.delayMinutes <= 60 * 24 * 7),
    String(market.delayMinutes));
  check('parseQuoteTime 认 MM-DD 写法（补当前年，不落到 2001 年）',
    (function () {
      var t = notices.parseQuoteTime('01-02 03:04:05');
      if (typeof t !== 'number') return false;
      var d = new Date(t + 8 * 3600000);
      return d.getUTCFullYear() === new Date().getUTCFullYear() &&
        d.getUTCMonth() === 0 && d.getUTCDate() === 2 &&
        d.getUTCHours() === 3 && d.getUTCMinutes() === 4;
    })());
  check('parseQuoteTime 认 YYYY-MM-DD 写法（按 UTC+8）',
    (function () {
      var t = notices.parseQuoteTime('2026-11-27 08:30:00');
      if (typeof t !== 'number') return false;
      return new Date(t + 8 * 3600000).toISOString().slice(0, 19) === '2026-11-27T08:30:00';
    })());

  // ---- 真实行情行：库里真有一条行情时的对外载荷 ----
  // ⚠️ 真实分支（库里那条记录）以前没人测过：axis 给成字符串、
  //    日线点被切片丢掉，都是在那条分支上出的问题。
  //    上面那条 brent 用例走的是**夹具写入的**行情记录（同样是真实分支）；
  //    「库里没有这个品种」的空态分支在下面单独钉。
  await dao.markets.upsert({
    symbol: 'wti',
    name: 'NYMEX原油',
    price: 83.33,
    changeAmount: -0.35,
    changePercent: -0.42,
    open: 84.81,
    prevClose: 83.68,
    high: 86.6,
    low: 82.57,
    quoteTime: '2026-11-28 03:56:01',
    delayed: true,
    series: [
      { date: '2026-11-25', value: 84.15 },
      { date: '2026-11-26', value: 84.91 },
      { date: '2026-11-27', value: 83.33 },
      { date: '2026-11-27 23:50:00', value: 83.33 },
      { date: '2026-11-28 03:50:00', value: 83.33 }
    ],
    source: 'market-wti'
  });
  var liveMarket = await notices.actionMarket({ symbol: 'wti', period: '1d' });
  check('真实行情：来源是真实数据（不是兜底数据）',
    liveMarket.source && liveMarket.source.mode === 'server', JSON.stringify(liveMarket.source));
  check('真实行情：axis 是三档数组（给字符串的话小程序 wx:for 会拆成字符）',
    Array.isArray(liveMarket.axis) && liveMarket.axis.length === 3, JSON.stringify(liveMarket.axis));
  check('真实行情：axis 三档都有内容',
    liveMarket.axis.every(function (a) { return typeof a === 'string' && a.length > 0; }),
    JSON.stringify(liveMarket.axis));
  check('真实行情：points 非空',
    Array.isArray(liveMarket.points) && liveMarket.points.length >= 2,
    JSON.stringify(liveMarket.points));
  check('真实行情：带品种口径说明（布伦特是 CFD、纽约是 NYMEX 近月）',
    typeof liveMarket.basis === 'string' && liveMarket.basis.length > 0, liveMarket.basis);
  check('真实行情：延时分钟数在合理范围（不是几千万分钟）',
    typeof liveMarket.delayMinutes === 'number' && liveMarket.delayMinutes >= 0 &&
    liveMarket.delayMinutes <= 60 * 24 * 30, String(liveMarket.delayMinutes));
  check('真实行情：涨跌方向是三态',
    ['up', 'down', 'flat'].indexOf(liveMarket.direction) >= 0, liveMarket.direction);
  check('真实行情：报价时间是 MM-DD 展示格式',
    /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(liveMarket.quoteTime), liveMarket.quoteTime);
  var weekMarket = await notices.actionMarket({ symbol: 'wti', period: '1w' });
  check('真实行情：1 周周期切得出多个点（日线点不能被丢掉）',
    Array.isArray(weekMarket.points) && weekMarket.points.length >= 3,
    JSON.stringify(weekMarket.points));

  // ---- 空态：库里没有这个品种时，不许再冒出演示数据 ----
  // ⚠️ 以前这里回落到共享模块的演示载荷（写死的 78.42 / 74.16，
  //    曲线是伪随机生成的，时间戳却按「现在」打）——
  //    用户看到的是「刚更新的实时行情」，却是假的。演示数据已删。
  await dao.markets.removeBySource('market-brent');
  var emptyMarket = await notices.actionMarket({ symbol: 'brent', period: '1d' });
  check('没有行情记录时返回空态标记（不是演示数据）',
    emptyMarket.empty === true, JSON.stringify(emptyMarket.empty));
  check('空态不标成演示源',
    !!emptyMarket.source && emptyMarket.source.mode !== 'demo',
    JSON.stringify(emptyMarket.source));
  check('空态没有价格也没有曲线',
    emptyMarket.price === null &&
    Array.isArray(emptyMarket.points) && emptyMarket.points.length === 0,
    JSON.stringify(emptyMarket.price) + ' / ' + JSON.stringify(emptyMarket.points));
  check('空态仍然给品种口径（页面要显示是哪个品种）',
    typeof emptyMarket.basis === 'string' && emptyMarket.basis.length > 0,
    emptyMarket.basis);
  check('空态的来源说明讲清楚「还没采到」',
    !!emptyMarket.source && String(emptyMarket.source.note).indexOf('还没有采集到') >= 0,
    emptyMarket.source ? emptyMarket.source.note : '无');

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
  check('模板字段与平台一致（thing5/amount2/amount6/phrase1/date3）',
    !!tpl && Object.keys(tpl.fields).sort().join(',') === 'amount2,amount6,date3,phrase1,thing5',
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
    date3: '2026年11月24日', amount6: '7.36元'
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
  // 方向模板（调整幅度是文本类型的那个）三处也要同步：
  // 服务端 .env（发消息用）、契约表（字段名）、小程序端 config（授权用）。
  // ⚠️ 小程序端漏了 → 用户没给这个模板授权 → 服务器下发吃 43101，额度白废。
  var savedDirectionTemplateId = configModule.subscribeDirectionTemplateId;
  check('服务端配了方向模板时，小程序端必须一起授权',
    !savedDirectionTemplateId ||
    miniConfig.subscribeDirectionTemplateId === savedDirectionTemplateId,
    miniConfig.subscribeDirectionTemplateId + ' vs ' + savedDirectionTemplateId);
  check('服务端配了方向模板时，它必须在契约表里登记过',
    !savedDirectionTemplateId || !!templates.templateOf(savedDirectionTemplateId),
    savedDirectionTemplateId);
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
    // ⚠️ 当前模板没有「温馨提示」字段：地区与口径并进「油品种类」，
    //    现价有自己的「实时油价」字段。
    check('官方降价的内容带地区与口径说明',
      hitByType.officialDrop.data.thing5.indexOf('广东') > 0 &&
      hitByType.officialDrop.data.thing5.indexOf('官方公布') > 0,
      hitByType.officialDrop.data.thing5);
    check('官方降价的现价有自己的字段',
      hitByType.officialDrop.data.amount6 === '7.36元',
      hitByType.officialDrop.data.amount6);
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
    check('预测下调标明非官方',
      hitByType.forecastDrop.data.thing5.indexOf('非官方') > 0,
      hitByType.forecastDrop.data.thing5);
    check('预测下调带来源给的区间',
      hitByType.forecastDrop.data.thing5.indexOf('0.06-0.08') > 0,
      hitByType.forecastDrop.data.thing5);
    check('预测下调的金额取来源给的区间下界（不编中值）',
      hitByType.forecastDrop.data.amount2 === '0.06元',
      hitByType.forecastDrop.data.amount2);
  }

  console.log('\n--- 模板没有「温馨提示」字段时：口径并进「油品种类」 ---');
  // ⚠️ 当前在用的模板把第 6 个关键词换成了「实时油价」——
  //    「温馨提示」没有了，地区、口径说明、区间全挤进「油品种类」（≤20 字符）。
  check('当前模板确实没有提示字段', !templates.hasRole(templateId, 'tip'), '有');
  check('当前模板有「实时油价」字段', templates.hasRole(templateId, 'price'), '没有');
  check('承载附加内容的字段是「油品种类」',
    !!templates.carrierOf(templateId) && templates.carrierOf(templateId).key === 'thing5',
    templates.carrierOf(templateId) ? templates.carrierOf(templateId).key : '没有');
  check('地区与口径并进「油品种类」，且没超 20 字',
    !!hitByType.officialDrop && hitByType.officialDrop.data.thing5.length <= 20 &&
    hitByType.officialDrop.data.thing5.indexOf('广东') > 0 &&
    hitByType.officialDrop.data.thing5.indexOf('官方公布') > 0,
    hitByType.officialDrop ? hitByType.officialDrop.data.thing5 : '没命中');
  // 装不下时按重要性取舍：地区先让位，区间与口径必须留着
  check('装不下的内容按重要性取舍（区间与口径留着，地区让位）',
    !!hitByType.forecastDrop &&
    hitByType.forecastDrop.data.thing5.indexOf('0.06-0.08') > 0 &&
    hitByType.forecastDrop.data.thing5.indexOf('非官方') > 0 &&
    hitByType.forecastDrop.data.thing5.indexOf('广东') < 0,
    hitByType.forecastDrop ? hitByType.forecastDrop.data.thing5 : '没命中');
  // 丢了内容要有日志，不能闷声丢掉
  var warns = [];
  var origWarn = console.warn;
  try {
    console.warn = function (msg) { warns.push(String(msg)); };
    alert.matchRule(
      { userId: 'u1', regionCode: '440000', fuelId: '92', forecastDrop: true },
      [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
      null,
      { kind: 'forecast', executeAt: '2026-11-26', direction: 'down', literMin: 0.06, literMax: 0.08 });
  } finally {
    console.warn = origWarn;
  }
  check('装不下的内容会记日志（不能闷声丢掉）',
    warns.some(function (w) { return w.indexOf('装不下') > 0; }), warns.join(' | '));

  console.log('\n--- 文本型「调整幅度」字段：三类提醒的取值 ---');
  // 文本类型的幅度字段能写整句，数字类型只放得下一个「0.52元」。
  // ⚠️ 文本类型也别只写「0.52」—— 用户看不出是每升还是每吨。
  var textTemplateId = 'TEST-TEXT-TEMPLATE';
  templates.registerTemplate(textTemplateId, {
    name: '油价调整提醒（文本型幅度，自检用）',
    kind: 'once',
    fields: {
      phrase1: { type: 'phrase', role: 'direction', label: '调整方向', max: 5 },
      thing2: { type: 'thing', role: 'amount', label: '调整幅度', max: 20 },
      date3: { type: 'date', role: 'date', label: '调整日期' },
      thing4: { type: 'thing', role: 'tip', label: '温馨提示', max: 20 },
      thing5: { type: 'thing', role: 'fuel', label: '油品种类', max: 20 }
    }
  });
  var savedPrimaryTemplateId = configModule.subscribeTemplateId;
  configModule.subscribeTemplateId = textTemplateId;
  var textHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92',
      officialDrop: true, targetEnabled: true, targetPrice: 7.5, forecastDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 7.36 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down', changes: { '92': -0.08 } },
    { kind: 'forecast', executeAt: '2026-11-26', direction: 'down', literMin: 0.06, literMax: 0.08 }
  );
  var textByType = {};
  textHits.forEach(function (h) { textByType[h.type] = h; });
  check('文本型幅度字段：官方降价写清楚是每升',
    !!textByType.officialDrop && textByType.officialDrop.data.thing2 === '每升下调0.08元',
    textByType.officialDrop ? textByType.officialDrop.data.thing2 : '没命中');
  check('文本型幅度字段：目标价写清楚是目标价',
    !!textByType.targetPrice && textByType.targetPrice.data.thing2 === '目标价7.50元',
    textByType.targetPrice ? textByType.targetPrice.data.thing2 : '没命中');
  check('文本型幅度字段：预测能把整个区间放下（数字类型只能放下界）',
    !!textByType.forecastDrop && textByType.forecastDrop.data.thing2 === '每升预计下调0.06-0.08元',
    textByType.forecastDrop ? textByType.forecastDrop.data.thing2 : '没命中');
  check('文本型模板的三类提醒都通过契约',
    Object.keys(textByType).length === 3 && Object.keys(textByType).every(function (k) {
      return templates.validate(textTemplateId, textByType[k].data).ok;
    }),
    JSON.stringify(textByType));
  configModule.subscribeTemplateId = savedPrimaryTemplateId;

  console.log('\n--- 带「当前价格」字段的模板 ---');
  // ⚠️ 当前模板没有当前价格字段，地区与现价全挤在 20 字的温馨提示里
  //（「广东现价8.39元·本地区实测」）。模板里给了「当前价格」字段之后，
  // 现价就该有自己的位置 —— 提示只留口径说明。
  var priceTemplateId = 'TEST-PRICE-TEMPLATE';
  templates.registerTemplate(priceTemplateId, {
    name: '油价调整提醒（带当前价格，自检用）',
    kind: 'once',
    fields: {
      thing5: { type: 'thing', role: 'fuel', label: '油品种类', max: 20 },
      phrase1: { type: 'phrase', role: 'direction', label: '调整方向', max: 5 },
      date3: { type: 'date', role: 'date', label: '调整日期' },
      amount2: { type: 'amount', role: 'price', label: '当前价格', max: 10 },
      thing4: { type: 'thing', role: 'tip', label: '温馨提示', max: 20 }
    }
  });
  var savedPriceTemplateId = configModule.subscribeTemplateId;
  configModule.subscribeTemplateId = priceTemplateId;
  var priceHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down',
      tonChanges: { gasoline: -645, diesel: -625 }, changes: {} },
    null,
    { localAmount: { before: 8.91, after: 8.39, delta: -0.52 } }
  );
  var priceHit = priceHits[0];
  check('有当前价格字段时，现价填自己的字段',
    !!priceHit && priceHit.data.amount2 === '8.39元',
    priceHit ? JSON.stringify(priceHit.data) : '没命中');
  check('有当前价格字段时，提示不再重复现价',
    !!priceHit && priceHit.data.thing4.indexOf('8.39') < 0,
    priceHit ? priceHit.data.thing4 : '没命中');
  check('模板没有幅度字段时，幅度并进提示（不能丢）',
    !!priceHit && priceHit.data.thing4.indexOf('0.52') > 0,
    priceHit ? priceHit.data.thing4 : '没命中');
  check('口径说明仍然在提示里',
    !!priceHit && priceHit.data.thing4.indexOf('本地区实测') > 0,
    priceHit ? priceHit.data.thing4 : '没命中');
  check('带当前价格字段的模板也能通过契约',
    !!priceHit && templates.validate(priceTemplateId, priceHit.data).ok,
    priceHit ? templates.validate(priceTemplateId, priceHit.data).errors.join(',') : '没命中');
  configModule.subscribeTemplateId = savedPriceTemplateId;

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
  check('官方降价标明是本地区实测',
    ndrcHits.length && ndrcHits[0].data.thing5.indexOf('本地区实测') > 0,
    ndrcHits.length ? ndrcHits[0].data.thing5 : '');

  var medianHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down',
      tonChanges: { gasoline: -645, diesel: -625 }, changes: {} },
    null,
    { medianAmounts: { '92': -0.52 } }
  );
  check('没有本地区快照时用各省中位数，并标明是测算',
    medianHits.length && medianHits[0].data.thing5.indexOf('测算') > 0,
    medianHits.length ? medianHits[0].data.thing5 : '没命中');

  check('官方上调不算降价提醒', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'up',
      tonChanges: { gasoline: 645, diesel: 625 }, changes: {} },
    null,
    { medianAmounts: { '92': 0.52 } }
  ).length === 0);

  console.log('\n--- 没有每升幅度时的官方方向提醒 ---');
  // ⚠️ 发改委公告只给吨价：白天发公告时新挂牌价还没采到，
  // 每升幅度拿不到 → 提醒发不出去，用户什么都收不到。
  //
  // 干净的做法是「方向模板」：它的「调整幅度」是**文本类型**，
  // 能原样写「幅度待公布」。
  // ⚠️ 不能填 0（那是冒充「持平」），也不能填吨价（那是混口径）。
  var directionTemplateId = 'TEST-DIRECTION-TEMPLATE';
  templates.registerTemplate(directionTemplateId, {
    name: '油价调整方向提醒（自检用）',
    kind: 'once',
    fields: {
      thing1: { type: 'thing', role: 'fuel', label: '油品种类', max: 20 },
      thing2: { type: 'thing', role: 'amount', label: '调整幅度', max: 20 },
      phrase3: { type: 'phrase', role: 'direction', label: '调整方向', max: 5 },
      date4: { type: 'date', role: 'date', label: '调整日期' },
      thing5: { type: 'thing', role: 'tip', label: '温馨提示', max: 20 }
    }
  });
  var noAmountNotice = { kind: 'official', executeAt: '2026-11-24', direction: 'down',
    tonChanges: { gasoline: -645, diesel: -625 }, changes: {} };
  var noAmountPrices = [{ regionCode: '440000', fuelId: '92', price: 8.39 }];

  // 没配方向模板：发不出去，但必须留下「为什么没发」的痕迹
  var skippedNoTemplate = [];
  var hitsNoTemplate = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    noAmountPrices, noAmountNotice, null,
    { skipped: skippedNoTemplate }
  );
  check('没有每升幅度又没有方向模板时，这条提醒发不出去',
    hitsNoTemplate.length === 0, JSON.stringify(hitsNoTemplate));
  check('发不出去的原因被记下来（NO_LITER_AMOUNT）',
    skippedNoTemplate.some(function (s) { return s.reason === 'NO_LITER_AMOUNT'; }),
    JSON.stringify(skippedNoTemplate));

  // 配了方向模板：官方方向明确是下调，就照发
  var savedDirectionId = configModule.subscribeDirectionTemplateId;
  configModule.subscribeDirectionTemplateId = directionTemplateId;
  var skippedWithTemplate = [];
  var hitsWithTemplate = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    noAmountPrices, noAmountNotice, null,
    { skipped: skippedWithTemplate }
  );
  check('配了方向模板后，没有每升幅度也照发方向提醒',
    hitsWithTemplate.length === 1, JSON.stringify(hitsWithTemplate));
  var dirHit = hitsWithTemplate[0];
  check('方向提醒用的是方向模板，不是主模板',
    !!dirHit && dirHit.template.id === directionTemplateId,
    dirHit ? dirHit.template.id : '没命中');
  check('方向提醒的幅度写的是「幅度待公布」（不是 0.00元）',
    !!dirHit && dirHit.data.thing2 === '幅度待公布',
    dirHit ? JSON.stringify(dirHit.data) : '没命中');
  check('方向提醒的字段全部通过模板契约',
    !!dirHit && templates.validate(directionTemplateId, dirHit.data).ok,
    dirHit ? templates.validate(directionTemplateId, dirHit.data).errors.join(',') : '没命中');
  check('方向提醒里没有任何「0.00元」（那是冒充持平）',
    !!dirHit && Object.keys(dirHit.data).every(function (k) {
      return String(dirHit.data[k]).indexOf('0.00元') < 0;
    }),
    dirHit ? JSON.stringify(dirHit.data) : '没命中');
  check('方向提醒的方向字段仍是「下调」',
    !!dirHit && dirHit.data.phrase3 === '下调',
    dirHit ? dirHit.data.phrase3 : '没命中');
  configModule.subscribeDirectionTemplateId = savedDirectionId;

  // 文本类型的幅度字段能放整句；amount 类型只认「数字+元」
  var textAmount = templates.dataByRole(directionTemplateId, {
    fuel: '92# 汽油', amountText: '每升下调0.52元', direction: '下调',
    date: '2026-11-24', tip: '广东现价8.39元'
  });
  check('文本类型的幅度字段能放整句',
    textAmount.thing2 === '每升下调0.52元', JSON.stringify(textAmount));
  var primaryAmount = templates.dataByRole(templates.PRIMARY_TEMPLATE_ID, {
    fuel: '92# 汽油', amount: 0.52, direction: '下调',
    date: '2026-11-24', tip: '广东现价8.39元'
  });
  check('主模板的幅度字段只放「数字+元」',
    primaryAmount.amount2 === '0.52元', JSON.stringify(primaryAmount));
  check('主模板装不下整句（放进去会被契约挡住）',
    !templates.validate(templates.PRIMARY_TEMPLATE_ID, {
      thing5: '92# 汽油', amount2: '每升下调0.52元', phrase1: '下调',
      date3: '2026年11月24日', amount6: '8.39元'
    }).ok);

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

  console.log('\n--- 官方吨价 → 每升折算：只给吨价时也要能给出每升幅度 ---');
  // ⚠️ 发改委公告只给吨价，公告当天各地挂牌价还没更新 ——
  //   没有实测幅度时，界面不能只剩「元/吨」，得给出折算值并标明非官方。
  // 用生成产物里的那一份（server/src/shared/shared.js）：
  // 线上只同步 server/ 与 data/reference-prices.js，data/ton-conversion.js 不在服务器上
  var conversion = require(path.join(ROOT, 'src', 'shared', 'shared.js')).TON_CONVERSION;
  var conversionMiss = [];
  conversion.CALIBRATION_ROUNDS.forEach(function (round) {
    Object.keys(round.measured).forEach(function (fuelId) {
      var got = conversion.convertTonToLiter(round.ton, fuelId);
      if (!isFinite(got) || Math.abs(got - round.measured[fuelId]) > 0.001) {
        conversionMiss.push(round.date + ' ' + fuelId + ' 折算 ' + got +
          ' / 实测 ' + round.measured[fuelId]);
      }
    });
  });
  check('折算系数能把三轮真实调价的 12 个实测值逐项复现',
    conversionMiss.length === 0, conversionMiss.join('；'));
  check('官方吨价 440 元/吨折出 92# 每升 -0.36 元',
    conversion.convertTonToLiter({ gasoline: -440 }, '92') === -0.36,
    String(conversion.convertTonToLiter({ gasoline: -440 }, '92')));
  check('没有对应吨价时不编数（返回 null）',
    conversion.convertTonToLiter({ gasoline: -440 }, '0') === null);

  var noticeDetail = require(path.join(ROOT, 'src', 'services', 'notice-detail.js'));
  var tonNotice = {
    id: 99,
    kind: 'official',
    title: '吨价公告',
    executeAt: '2026-11-26',
    direction: 'down',
    tonChanges: { gasoline: -440, diesel: -425 },
    changes: {},
    summary: '',
    source: {}
  };
  // 既没有实测中位数、也没有本地区快照 → 只能靠折算补出每升幅度与调后价
  var tonPayload = noticeDetail.buildNotice(tonNotice, {
    measured: {},
    snapshots: {},
    prices: {
      '92': { price: 8.39, changeAt: '2026-11-13' },
      '95': { price: 9.09, changeAt: '2026-11-13' },
      '98': { price: 11.09, changeAt: '2026-11-13' },
      '0': { price: 8.06, changeAt: '2026-11-13' }
    },
    today: '2026-11-26'
  });
  check('只有官方吨价时也能给出每升幅度（折算）',
    tonPayload.deltas['92'] === -0.36 && tonPayload.deltas['0'] === -0.37,
    JSON.stringify(tonPayload.deltas));
  check('折算出来的幅度来源标成 ton（不是官方公布值）',
    tonPayload.deltaSource['92'] === 'ton', tonPayload.deltaSource['92']);
  check('官方每升幅度字段仍然是空的（不把折算值混进官方字段）',
    Object.keys(tonPayload.changes).length === 0, JSON.stringify(tonPayload.changes));
  check('折算值单独放在 convertedChanges 里',
    tonPayload.convertedChanges['92'] === -0.36, JSON.stringify(tonPayload.convertedChanges));
  check('本轮没挂出新挂牌价时：现价是调前价，调后价 = 现价 + 幅度',
    tonPayload.prices['92'].before === 8.39 && tonPayload.prices['92'].after === 8.03,
    JSON.stringify(tonPayload.prices['92']));
  check('价格行的差值与前后价自洽',
    Object.keys(tonPayload.prices).every(function (fuelId) {
      var row = tonPayload.prices[fuelId];
      return Math.abs((row.after - row.before) - row.delta) < 0.001;
    }),
    JSON.stringify(tonPayload.prices));
  check('价格行标明是折算出来的',
    tonPayload.prices['92'].basis === 'ton', tonPayload.prices['92'].basis);

  // 挂牌价已经含这次调价 → 不能再拿现价推一遍（那会重复加一次幅度）
  var appliedPayload = noticeDetail.buildNotice(tonNotice, {
    measured: {},
    snapshots: {},
    prices: { '92': { price: 8.03, changeAt: '2026-11-27' } },
    today: '2026-11-26'
  });
  check('挂牌价已经含这次调价时不再拿现价推一遍',
    !appliedPayload.prices['92'], JSON.stringify(appliedPayload.prices));

  // 旧轮次没有本地区快照时，不能拿今天的价去讲那一轮
  var oldPayload = noticeDetail.buildNotice({
    id: 98,
    kind: 'official',
    title: '旧轮次',
    executeAt: '2026-09-24',
    direction: 'up',
    tonChanges: { gasoline: 395, diesel: 385 },
    changes: {},
    summary: '',
    source: {}
  }, {
    measured: {},
    snapshots: {},
    prices: { '92': { price: 8.39, changeAt: '2026-11-13' } },
    today: '2026-11-26'
  });
  check('旧轮次没有本地区快照时不拿今天的价当调后价',
    !oldPayload.prices['92'], JSON.stringify(oldPayload.prices));
  check('旧轮次仍然给得出每升幅度（折算）',
    oldPayload.deltas['92'] === 0.32, JSON.stringify(oldPayload.deltas));

  // 本地区有快照 → 用快照（实测），不拿折算值顶替
  var localPayload = noticeDetail.buildNotice(tonNotice, {
    measured: {},
    snapshots: { '92': { before: 8.91, after: 8.39, delta: -0.52, date: '2026-11-27' } },
    prices: { '92': { price: 8.39, changeAt: '2026-11-13' } }
  });
  check('本地区有快照时用实测值（不拿折算值顶替）',
    localPayload.deltas['92'] === -0.52 && localPayload.deltaSource['92'] === 'local',
    JSON.stringify(localPayload.deltas));
  check('本地区快照的调前调后价原样给出',
    localPayload.prices['92'].before === 8.91 && localPayload.prices['92'].after === 8.39,
    JSON.stringify(localPayload.prices['92']));

  console.log('\n--- 方向一致性：反方向的快照不能包装成降价消息 ---');
  // ⚠️ 以前这里对幅度取绝对值：公告说下调、快照却是上涨时，
  // 会发出「下调 + 0.20元」这种自相矛盾的消息。
  var reversedHits = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down', changes: {} },
    null,
    { localAmount: { before: 8.19, after: 8.39, delta: 0.20 } }
  );
  check('官方下调 + 本地区正向 delta 不生成降价消息',
    reversedHits.length === 0, JSON.stringify(reversedHits));
  var reversedWithMedian = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'down', changes: {} },
    null,
    { localAmount: { before: 8.19, after: 8.39, delta: 0.20 }, medianAmounts: { '92': -0.52 } }
  );
  check('本地区快照反方向时改用各省中位数',
    reversedWithMedian.length === 1 && reversedWithMedian[0].data.amount2 === '0.52元',
    JSON.stringify(reversedWithMedian.map(function (h) { return h.data.amount2; })));
  check('官方上调时不生成降价消息', alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', officialDrop: true },
    [{ regionCode: '440000', fuelId: '92', price: 8.39 }],
    { kind: 'official', executeAt: '2026-11-24', direction: 'up', changes: {} },
    null,
    { medianAmounts: { '92': -0.52 } }
  ).length === 0);

  console.log('\n--- 目标价提醒：按价格事件去重 ---');
  // ⚠️ 原来去重键只带目标价：同一目标价发过一次之后，
  // 用户重新授权也发不出来（旧键把它永久挡住了）。
  var targetEvent1 = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', targetEnabled: true, targetPrice: 8 },
    [{ regionCode: '440000', fuelId: '92', price: 7.36, changeAt: '2026-11-10' }], null, null)[0];
  var targetEvent2 = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', targetEnabled: true, targetPrice: 8 },
    [{ regionCode: '440000', fuelId: '92', price: 7.36, changeAt: '2026-11-24' }], null, null)[0];
  check('同一目标价、不同价格事件 → 去重键不同（下一轮还能再提醒）',
    !!targetEvent1 && !!targetEvent2 && targetEvent1.dedupKey !== targetEvent2.dedupKey,
    targetEvent1 && targetEvent2 ? (targetEvent1.dedupKey + ' vs ' + targetEvent2.dedupKey) : '没命中');
  var targetEvent3 = alert.matchRule(
    { userId: 'u1', regionCode: '440000', fuelId: '92', targetEnabled: true, targetPrice: 8 },
    [{ regionCode: '440000', fuelId: '92', price: 7.36, changeAt: '2026-11-10' }], null, null)[0];
  check('同一个价格事件 → 去重键相同（不会反复提醒）',
    !!targetEvent1 && !!targetEvent3 && targetEvent1.dedupKey === targetEvent3.dedupKey,
    targetEvent1 && targetEvent3 ? (targetEvent1.dedupKey + ' vs ' + targetEvent3.dedupKey) : '没命中');

  console.log('\n--- 快照变化点：不能归到下一轮 ---');
  // 下一轮的价格提前挂出来，落进本轮的 +12 天窗口。
  // 取「最后一个变化点」会归错轮次，取「离执行日最近的」才对。
  var mixedPoint = measureService.changePointAt([
    { date: '2026-10-25', price: 9.00 },
    { date: '2026-11-02', price: 8.50 },
    { date: '2026-11-10', price: 8.40 }
  ], '2026-11-01');
  check('下一轮提前挂价时，本轮取自己的变化点',
    !!mixedPoint && mixedPoint.date === '2026-11-02' &&
    Math.abs(mixedPoint.delta + 0.50) < 0.001,
    JSON.stringify(mixedPoint));
  check('只有本轮变化时取的就是本轮',
    (function () {
      var p = measureService.changePointAt([
        { date: '2026-10-25', price: 9.00 },
        { date: '2026-11-02', price: 8.50 }
      ], '2026-11-01');
      return !!p && p.date === '2026-11-02';
    })());

  // 窗口里混着上一轮遗留的价差（方向与官方相反）→ 不是本轮的变化点
  var signPoint = measureService.changePointAt([
    { date: '2026-10-25', price: 9.00 },
    { date: '2026-11-01', price: 9.10 },
    { date: '2026-11-03', price: 8.50 }
  ], '2026-11-01', { expectSign: -1 });
  check('方向与官方相反的价格变化不算本轮的变化点',
    !!signPoint && signPoint.date === '2026-11-03' &&
    Math.abs(signPoint.delta + 0.60) < 0.001,
    JSON.stringify(signPoint));

  // 离生效日一样近时取靠后的那个（生效日前后的变化属于本轮）
  var tiePoint = measureService.changePointAt([
    { date: '2026-10-25', price: 9.00 },
    { date: '2026-10-31', price: 8.50 },
    { date: '2026-11-02', price: 8.40 }
  ], '2026-11-01');
  check('离生效日同样近时取靠后的那个变化点',
    !!tiePoint && tiePoint.date === '2026-11-02', JSON.stringify(tiePoint));

  // 变化点不得越过下一轮执行日（下一轮迟挂的价不能算到本轮头上）
  var boundedPoint = measureService.changePointAt([
    { date: '2026-10-20', price: 9.00 },
    { date: '2026-10-26', price: 8.50 },
    { date: '2026-11-03', price: 8.40 }
  ], '2026-11-01', { nextDate: '2026-11-02' });
  check('变化点不得越过下一轮执行日',
    !!boundedPoint && boundedPoint.date === '2026-10-26', JSON.stringify(boundedPoint));

  console.log('\n--- 老规则回填生效时间 ---');
  // ⚠️ 只加列不回填的话，老规则的 armed_at 是 NULL，
  // 而提醒器对「没有 armedAt 的规则」不做旧事件过滤 ——
  // 老用户仍会收到早已过去的调价通知。
  await dbModule.pool.query(
    "INSERT INTO alert_rules (user_id, region_code, fuel_id, armed_at) VALUES ('legacy-openid', '440000', '92', NULL)"
  );
  // 只跑 schema.sql 里那条回填语句（pg-mem 不支持重复执行 CREATE TABLE IF NOT EXISTS）
  var backfill = (fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')
    .match(/UPDATE\s+alert_rules\s+SET\s+armed_at[\s\S]*?;/i) || [])[0];
  check('schema.sql 里有老规则回填 armed_at 的语句', !!backfill);
  if (backfill) {
    await dbModule.pool.query(backfill);
  }
  var legacyResult = await dbModule.pool.query(
    "SELECT armed_at FROM alert_rules WHERE user_id = 'legacy-openid'"
  );
  // pg-mem 与 pg 的 query 都返回 { rows: [...] }，统一从 rows 里取
  var legacyRows = (legacyResult && legacyResult.rows) ? legacyResult.rows : (legacyResult || []);
  check('老规则回填出 armed_at（不再绕过旧事件过滤）',
    legacyRows.length === 1 && legacyRows[0].armed_at !== null && legacyRows[0].armed_at !== undefined,
    JSON.stringify(legacyRows));

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

  var grantSnapshot = (await dao.rules.listByUser('openid-fields'))[0];
  await user.actionRulesSave('openid-fields', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetEnabled: false,
      targetPrice: 7.25, forecastDrop: true }
  ]);
  var afterEdit = (await dao.rules.listByUser('openid-fields'))[0];
  check('发送期间只改条件：额度版本不变', afterEdit.version === grantSnapshot.version,
    JSON.stringify({ before: grantSnapshot.version, after: afterEdit.version }));
  check('发送期间只改条件：改条件不会把额度用掉', afterEdit.subscribeGranted === true,
    JSON.stringify({ granted: afterEdit.subscribeGranted }));
  // ⚠️ 核销之后必须**重新查库**再断言。
  //   拿核销前读出来的旧对象断言 subscribeGranted，它恒为 true —— 等于没验到核销。
  var consumedByOld = await dao.rules.consumeSubscribe(grantSnapshot);
  var afterConsume = (await dao.rules.listByUser('openid-fields'))[0];
  check('发送期间只改条件：旧快照仍能核销已用额度',
    consumedByOld === true && afterConsume.subscribeGranted === false && !!afterConsume.subscribeUsedAt,
    JSON.stringify({ consumed: consumedByOld, granted: afterConsume.subscribeGranted,
      usedAt: afterConsume.subscribeUsedAt }));

  await user.actionRulesSave('openid-fields', [
    { regionCode: '440000', fuelId: '92', officialDrop: true, targetEnabled: false,
      targetPrice: 7.15, forecastDrop: true, subscribeGranted: true }
  ]);
  var oldConsumed = await dao.rules.consumeSubscribe(grantSnapshot);
  var afterRegrant = (await dao.rules.listByUser('openid-fields'))[0];
  check('发送期间重新授权：旧快照不能消费新额度', oldConsumed === false && afterRegrant.subscribeGranted === true,
    JSON.stringify({ oldConsumed: oldConsumed, granted: afterRegrant.subscribeGranted }));
  var consumedNow = await dao.rules.consumeSubscribe(afterRegrant);
  var afterConsumeNow = (await dao.rules.listByUser('openid-fields'))[0];
  check('当前快照能消费额度（核销后额度确实被清掉）',
    consumedNow === true && afterConsumeNow.subscribeGranted === false && !!afterConsumeNow.subscribeUsedAt,
    JSON.stringify({ consumed: consumedNow, granted: afterConsumeNow.subscribeGranted,
      usedAt: afterConsumeNow.subscribeUsedAt }));
  check('同一个快照不能重复消费额度', await dao.rules.consumeSubscribe(afterRegrant) === false);

  console.log('\n--- 各省价格 vs 真实挂牌价 ---');
  // data/reference-prices.js 是各省发改委公布的最高零售价基准。
  // 算出来的价格必须与它一致 —— 这条守住「地区价差」模型的核心正确性：
  // offset 写错、基准价没校准、offset 忘了按油品分列，都会被抓出来。
  //
  // ⚠️ 算价的是**测试夹具**里的价格阶梯（scripts/test-fixtures.js）：
  //    演示数据已从小程序端删除，生产价格来自采集器抓到的各省挂牌价，
  //    这套「全国价 + 地区价差」的模型现在只用来验证地区价差口径。
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
      var calc = fixtures.currentPrice(region.code, fuel.id);
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

  // ⚠️ 以前这里还有一条「服务端与小程序端价格完全一致」：
  //    小程序端有一份演示源、服务端有一份共享副本，两边比的是同一套算法。
  //    演示数据删除后只剩一份实现（测试夹具里），比的东西没有了 —— 那条断言已删。

  // 夹具的日期平移：种子数据必须一直「新鲜」
  //
  // ⚠️ 夹具的调价节点按「今天 - 锚点」整体平移（scripts/test-fixtures.js）。
  //    不平移的话，几周后种子就停在 2026-11-10：调价节点全在过去、
  //    下一轮窗口早就过期，窗口倒计时与进度相关的断言会随日期漂。
  // 这里伪造几个未来时点，断言「下一轮窗口」一直在未来。
  console.log('\n--- 夹具日期平移（未来不会退化）---');
  var degradeProblems = [];
  [0, 30, 60, 120, 240].forEach(function (offsetDays) {
    var RealDate = Date;
    var shifted = new RealDate(RealDate.now() + offsetDays * 86400000);
    function FakeDate() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length === 0) return new RealDate(shifted.getTime());
      return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return shifted.getTime(); };
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    global.Date = FakeDate;
    var fixturePath = require.resolve(path.join(ROOT, 'scripts', 'test-fixtures.js'));
    try {
      // 换时间必须重新加载夹具：levels 里有缓存
      delete require.cache[fixturePath];
      var fresh = require(fixturePath);
      var list = fresh.levels('92');
      var last = list[list.length - 1];
      var next = new Date(new Date(last.date + 'T00:00:00Z').getTime() + 10 * 86400000);
      var nextDate = next.toISOString().slice(0, 10);
      var daysLeft = Math.round((Date.parse(nextDate + 'T00:00:00Z') -
        Date.parse(fresh.today() + 'T00:00:00Z')) / 86400000);
      if (daysLeft <= 0) {
        degradeProblems.push('+' + offsetDays + '天：下一轮窗口在过去（剩 ' + daysLeft + ' 天）');
      }
    } finally {
      global.Date = RealDate;
      delete require.cache[fixturePath];
    }
  });
  check('夹具日期平移：任意未来时点下一轮窗口都在未来', degradeProblems.length === 0,
    degradeProblems.join('；'));

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
  check('历史记录的 sent 字符串被拒', expectCode(function () {
    userService.actionHistorySave('u-history', [{ sent: 'false' }]);
  }, 'INVALID_HISTORY'));
  check('历史记录的 NaN 价格被拒', expectCode(function () {
    userService.actionHistorySave('u-history', [{ price: NaN }]);
  }, 'INVALID_HISTORY'));
  check('历史记录的超长标题被拒', expectCode(function () {
    userService.actionHistorySave('u-history', [{ title: new Array(122).join('长') }]);
  }, 'INVALID_HISTORY'));
  var historyDoc = userService.toDbHistory('u-history', {
    dedupKey: 'local-key', sent: false, title: '失败记录', price: 8.39, admin: '不应入库'
  });
  check('历史记录只保留白名单 payload 字段',
    historyDoc.payload.admin === undefined && historyDoc.payload.title === '失败记录' &&
    historyDoc.payload.price === 8.39 && historyDoc.payload.sent === false,
    JSON.stringify(historyDoc.payload));

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

  var sendingReserved = await dao.logs.reserve({ userId: 'u-sending', dedupKey: 'sending::key', payload: {} });
  var sendingMarked = await dao.logs.markSending(sendingReserved.id);
  check('发送前登记 send_started_at', !!sendingMarked && !!sendingMarked.sendStartedAt);
  check('同一条占位不能重复登记为发送中',
    await dao.logs.markSending(sendingReserved.id) === null);

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

  console.log('\n--- 来源轮次结束后清理旧预测，抓取失败则保留 ---');
  var clearSource = { id: 'test-window-clear-src', name: '清理测试源', verifyRegions: ['440000'] };
  var clearRegion = shared.REGIONS.filter(function (r) { return r.code === '440000'; })[0];
  var clearSlugBefore = clearRegion.slugs[clearSource.id];
  clearRegion.slugs[clearSource.id] = 'guangdong';
  var clearTrend = function (date, isForecast) {
    return {
      ok: true,
      parsed: {
        prices: { '92': 8.39, '95': 8.89, '98': 10.89, '0': 8.06 },
        trend: { date: date, time: '24:00', direction: 'down', changeTon: -645,
          literMin: 0.08, literMax: 0.1, isForecast: isForecast }
      }
    };
  };
  var seedOldWindow = async function () {
    await collector.saveWindow(clearSource,
      { date: '2099-01-10', time: '24:00', direction: 'down', changeTon: null, literMin: 0.08, literMax: 0.1 });
  };
  var collectClear = function (cached) {
    var cache = {};
    cache[clearSource.id + '|440000'] = cached;
    return collector.collectForecastSource(clearSource, { cache: cache });
  };

  await seedOldWindow();
  var clearResult = await collectClear(clearTrend('2026-11-12', false));
  check('来源明确给已执行结果时删掉旧预测',
    !(await dao.windows.latestBySource(clearSource.id)) && clearResult.advisories.some(function (a) {
      return a.reason === 'WINDOW_NOT_FORECAST';
    }), JSON.stringify(clearResult.advisories));

  await seedOldWindow();
  await collectClear(clearTrend('2000-01-01', true));
  check('来源只给过期轮次时删掉旧预测', !(await dao.windows.latestBySource(clearSource.id)));

  await seedOldWindow();
  var clearFailed = await collectClear({ ok: false, reason: 'SOURCE_BLOCKED', message: '测试拒绝' });
  check('全部抓取失败时保留最后一条预测', !!(await dao.windows.latestBySource(clearSource.id)) &&
    clearFailed.status === 'needsReview');

  await collectClear(clearTrend('2099-02-10', true));
  var clearFuture = await dao.windows.latestBySource(clearSource.id);
  check('有效未来预测正常保存并标记为预测', !!clearFuture && clearFuture.date === '2099-02-10' &&
    clearFuture.forecast.isForecast === true, clearFuture ? JSON.stringify(clearFuture.forecast) : '无');
  if (clearSlugBefore === undefined) delete clearRegion.slugs[clearSource.id];
  else clearRegion.slugs[clearSource.id] = clearSlugBefore;

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

  console.log('\n--- 现价跳变拒绝：旧价与当天历史不被污染 ---');
  var jumpSource = { id: 'test-price-jump-src', name: '跳变测试源' };
  var jumpRegion = { code: '990099', name: '跳变省', city: '跳变市' };
  var jumpPrices = { '92': 8.0, '95': 9.0, '98': 11.0, '0': 8.5 };
  await collector.saveRegionPrices(jumpSource, jumpRegion, { prices: jumpPrices }, {});
  var jumpExisting = { '990099': {} };
  (await dao.prices.listByRegion('990099')).forEach(function (p) { jumpExisting['990099'][p.fuelId] = p; });
  var jumpRejected = await collector.saveRegionPrices(jumpSource, jumpRegion, {
    prices: { '92': 20, '95': 21, '98': 23, '0': 20.5 }
  }, jumpExisting);
  var jumpRows = await dao.prices.listByRegion('990099');
  check('现价跳变过大时整省拒绝', jumpRejected.ok === false && jumpRejected.reason === 'PRICE_JUMP');
  check('拒绝后当前价仍是旧值', jumpRows.length === 4 && jumpRows.every(function (p) {
    return Number(p.price) === jumpPrices[p.fuelId];
  }), JSON.stringify(jumpRows));
  var jumpHistory = await dao.history.listByRegion('990099');
  check('拒绝后没有写入异常当天历史', jumpHistory.length === 4 && jumpHistory.every(function (h) {
    return Number(h.price) === jumpPrices[h.fuelId];
  }), '实际 ' + jumpHistory.length + ' 行');

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

  var measuredNoticeDate = new Date(new Date(trendToday + 'T00:00:00Z').getTime() - 10 * 86400000)
    .toISOString().slice(0, 10);
  var measuredNoticeKey = 'test::measured::' + measuredNoticeDate;
  await dao.notices.insert({
    dedupKey: measuredNoticeKey, kind: 'official', title: '测算口径测试公告',
    publishedAt: new Date().toISOString(), executeAt: measuredNoticeDate,
    changes: {}, tonChanges: { gasoline: -645, diesel: -625 }, reviewStatus: 'approved'
  });
  var originalMeasureMany = measureService.measureMany;
  measureService.measureMany = function (dates) {
    var out = {};
    dates.forEach(function (d) { out[d] = { '92': -0.52 }; });
    return Promise.resolve(out);
  };
  var measuredTrend;
  try {
    measuredTrend = await query.actionTrend({ regionCode: '440000', fuelId: '92', period: '3m' });
  } finally {
    measureService.measureMany = originalMeasureMany;
    await dbModule.pool.query('DELETE FROM oil_notices WHERE dedup_key = $1', [measuredNoticeKey]);
  }
  var measuredOfficial = (measuredTrend.events || []).filter(function (e) {
    return e.title === '测算口径测试公告';
  })[0];
  check('官方节点的每升金额明确标记为挂牌价测算',
    !!measuredOfficial && measuredOfficial.amountKnown === true && measuredOfficial.measured === true,
    JSON.stringify(measuredOfficial));

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

  var flat = alertService.buildData(subscribeTemplates.PRIMARY_TEMPLATE_ID, {
    fuel: '92# 汽油', amountNumber: 0.13, direction: '下调', date: '2026-11-24',
    priceNumber: 8.39, priceText: '现价8.39元', region: '广东'
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

  // 变化点窗口不得越过下一轮执行日
  // ⚠️ 发改委提前约 10 天公布下一轮：那条公告的生效日在**未来**，
  //   走势页只测算视图内的轮次，但下一轮执行日必须留着当窗口边界。
  //   少了它，窗口放开到 +12 天 → 本轮的变化点找不到时，
  //   会拿下一轮的价差当本轮幅度（每升幅度整轮错位）。
  await pushHistory(buildRows(shared.REGIONS, [
    ['2029-06-09', 8.91], ['2029-06-10', 8.91], ['2029-06-20', 8.39]
  ]));
  var boundaryTon = { '2029-06-10': { gasoline: -645, diesel: -625 } };
  var measuredNoBound = await measure.measureMany(['2029-06-10'], boundaryTon);
  check('不给下一轮执行日时窗口会放到 +12 天（这就是回归的形态）',
    typeof (measuredNoBound['2029-06-10'] || {})['92'] === 'number', JSON.stringify(measuredNoBound));
  var measuredWithBound = await measure.measureMany(['2029-06-10'], boundaryTon, '2029-06-20');
  check('给了下一轮执行日后不会取到下一轮的变化点',
    typeof (measuredWithBound['2029-06-10'] || {})['92'] !== 'number', JSON.stringify(measuredWithBound));

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

  await pgPool.query(
    'INSERT INTO alert_logs (user_id, dedup_key, time, sent, fail_reason, send_started_at, payload) ' +
    'VALUES ($1, $2, $3::timestamptz, FALSE, NULL, $3::timestamptz, $4::jsonb)',
    ['u4', 'stale-sending::key', new Date(Date.now() - 30 * 60 * 1000).toISOString(), JSON.stringify({})]
  );
  var staleSending = await dao.logs.reserve({ userId: 'u4', dedupKey: 'stale-sending::key', payload: {} });
  check('已开始外部发送的过期占位不能被自动重抢', !staleSending);

  // 超时是**结果未知**：微信可能已经投递了，重发就是重复消息。
  // 占位不能还回去 —— DAO 层直接不让 release 动「发送中」的行。
  check('请求超时算结果未知', alertService.isUnknownOutcome('微信接口请求总时限已到') === true);
  check('平台限流不算结果未知（确定没送达）',
    alertService.isUnknownOutcome('45009:api freq out of limit') === false);
  var unknownReserved = await dao.logs.reserve({ userId: 'u5', dedupKey: 'unknown::key', payload: {} });
  await dao.logs.markSending(unknownReserved.id);
  await dao.logs.release(unknownReserved.id);
  var unknownLeft = await dao.logs.listByUser('u5', 50);
  check('结果未知的占位释放不掉（不会被自动重发）',
    !unknownLeft.some(function (h) { return h.dedupKey === 'unknown::key'; }) &&
    !(await dao.logs.reserve({ userId: 'u5', dedupKey: 'unknown::key', payload: {} })));
  // 平台明确拒收：确认没送达 → 撤掉发送中 → 占位可释放，下一轮能重发
  var rejectedReserved = await dao.logs.reserve({ userId: 'u6', dedupKey: 'rejected::key', payload: {} });
  await dao.logs.markSending(rejectedReserved.id);
  await dao.logs.markNotSending(rejectedReserved.id);
  await dao.logs.release(rejectedReserved.id);
  check('平台明确拒收后占位能释放（下一轮能重发）',
    !!(await dao.logs.reserve({ userId: 'u6', dedupKey: 'rejected::key', payload: {} })));

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

  console.log('\n--- 站点拒绝访问：识别、熔断、状态诚实化 ---');
  var httpClient = require(path.join(ROOT, 'src', 'services', 'http-client.js'));
  var collector = require(path.join(ROOT, 'src', 'services', 'collector.js'));
  var sourceCfg = require(path.join(ROOT, 'src', 'services', 'sources.js'));

  // 软 403：HTTP 状态是 200，正文却是 nginx 的 403 错误页
  var nginx403 = '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n' +
    '<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>';
  check('HTTP 200 + nginx 403 页被认成「被拒」', !!httpClient.detectBlockPage(nginx403));
  check('真实页面不会被误判成被拒',
    httpClient.detectBlockPage('<div class="price-card n92"><span class="price-value">8.39</span></div>') === null);
  check('长正文里出现关键词也不判为被拒',
    httpClient.detectBlockPage('<p>403 Forbidden</p>' + 'x'.repeat(5000)) === null);

  // 熔断：连续被拒才熔断，抓成功就解除
  httpClient.resetBlocked();
  httpClient.markBlocked('selftest-src', '403 Forbidden');
  httpClient.markBlocked('selftest-src', '403 Forbidden');
  check('连着两次被拒还不熔断', httpClient.isBlocked('selftest-src') === false);
  httpClient.markBlocked('selftest-src', '403 Forbidden');
  check('第三次被拒熔断', httpClient.isBlocked('selftest-src') === true);
  check('被拒次数记着', httpClient.blockedInfo('selftest-src').count === 3);
  httpClient.clearBlocked('selftest-src');
  check('抓成功后解除熔断', httpClient.isBlocked('selftest-src') === false);
  httpClient.resetBlocked();

  // 内部源失败不进 needsReview
  check('内部源失败进 advisory 桶', collector.resultBucket({ status: 'failed', internal: true }) === 'advisory');
  check('用户侧来源失败进 needsReview 桶', collector.resultBucket({ status: 'failed' }) === 'needsReview');
  check('正常结果不进任何桶', collector.resultBucket({ status: 'ok' }) === null);
  var timelineSrc = sourceCfg.SOURCES.filter(function (x) { return x.id === 'xmgcn-timeline'; })[0];
  check('时间表源是内部源', !!timelineSrc && timelineSrc.internal === true);
  check('油价网是用户侧来源', collector.isUserFacingSource(
    sourceCfg.SOURCES.filter(function (x) { return x.id === 'xmgcn'; })[0]) === true);
  check('发改委公告是用户侧来源', collector.isUserFacingSource(
    sourceCfg.SOURCES.filter(function (x) { return x.id === 'ndrc-notice'; })[0]) === true);

  // 官方吨价 → 互校轮次（执行日 +1 天 = 挂牌价生效日）
  var tonRows = await dao.notices.listApprovedWithTon(60);
  var tonRounds = collector.tonRoundsFromNotices(tonRows);
  check('能从已入库公告里取出官方吨价轮次', tonRounds.length > 0, '实际 ' + tonRounds.length);
  function shiftDay(d) {
    var t = Date.parse(d + 'T00:00:00Z');
    if (!isFinite(t)) return null;
    return new Date(t + 86400000).toISOString().slice(0, 10);
  }
  var bigRound = tonRounds.filter(function (r) { return r.gasolineDelta === -645; })[0];
  check('645 元/吨那一轮的汽油吨价取到了', !!bigRound);
  check('柴油吨价也带上了', !!bigRound && bigRound.dieselDelta === -625);
  // 日期口径：公告写「X月X日24时起」，新挂牌价从**次日** 00:00 才开始挂，
  // 所以互校用的日期是执行日 +1 天（不能直接拿执行日去对历史表的生效日）
  var execRow = tonRows.filter(function (n) { return (n.tonChanges || {}).gasoline === -645; })[0];
  var execDate = execRow ? String(execRow.executeAt || '').slice(0, 10) : '';
  check('执行日 +1 天 = 挂牌价生效日', !!execDate && !!bigRound && bigRound.date === shiftDay(execDate),
    '执行日 ' + execDate + '，算出来 ' + (bigRound && bigRound.date));
  check('搁浅轮次（没有吨价）不参与互校',
    tonRounds.every(function (r) { return r.gasolineDelta !== 0; }));

  // 主源被拒时，调价节点改用库内历史推导（不能静默停更）
  var builtDb = await collector.buildSeries({
    adopted: { '440000': { parsed: { prices: { '92': 8.39 } } } }
  });
  check('来源没有历史时回落到库内历史', builtDb.from === 'db');
  check('库内历史里有广东的数据', Object.keys(builtDb.series['440000'] || {}).length > 0);
  var builtSrc = await collector.buildSeries({
    adopted: { '440000': { parsed: { prices: { '92': 8.39 }, history: [{ date: '2026-01-01', prices: { '92': 8.0 } }] } } }
  });
  check('有来源历史时优先用来源历史', builtSrc.from === 'source');

  var builtRejected = await collector.buildSeries({
    adopted: { '990099': { parsed: { prices: { '92': 8.0 }, history: [{ date: '2026-01-01', prices: { '92': 8.0 } }] } } },
    rejected: { '990099': true }
  });
  check('唯一地区被现价闸门拒绝时不回落旧历史', builtRejected.from === 'none' &&
    Object.keys(builtRejected.series).length === 0, JSON.stringify(builtRejected));
  var builtMixed = await collector.buildSeries({
    adopted: {
      '440000': { parsed: { prices: { '92': 8.0 }, history: [{ date: '2026-01-01', prices: { '92': 8.0 } }] } },
      '370000': { parsed: { prices: { '92': 8.1 }, history: [{ date: '2026-01-01', prices: { '92': 8.1 } }] } }
    },
    rejected: { '370000': true }
  });
  check('混合采纳与拒绝时历史只使用未拒绝地区', builtMixed.from === 'source' &&
    Object.keys(builtMixed.series).join(',') === '440000', JSON.stringify(builtMixed.series));
  var builtDbRejected = await collector.buildSeries({
    adopted: { '370000': { parsed: { prices: { '92': 8.39 } } } },
    rejected: { '440000': true, '990002': true }
  });
  check('回落库内历史时也排除被拒绝地区', builtDbRejected.from === 'db' &&
    !builtDbRejected.series['440000'] && !builtDbRejected.series['990002']);

  // 只有内部告警时，同步状态不能变成「等待人工核对」
  await dao.runs.insert({
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'ok',
    sourceName: '服务端定时采集',
    results: [{
      sourceId: 'xmgcn-timeline',
      status: 'degraded',
      reason: 'SOURCE_BLOCKED',
      message: '站点在拒绝访问',
      internal: true
    }],
    needsReview: [],
    advisories: [{
      sourceId: 'xmgcn-timeline',
      reason: 'SOURCE_BLOCKED',
      message: '站点在拒绝访问'
    }]
  });
  var syncAfter = await notices.actionSyncStatus();
  check('只有内部告警时同步状态仍是 ok（不是 pending）', syncAfter.status === 'ok', '实际 ' + syncAfter.status);
  check('内部告警照样能查到', Array.isArray(syncAfter.advisories) && syncAfter.advisories.length === 1);
  check('来源健康能查到是哪个源出的问题',
    Array.isArray(syncAfter.sources) && syncAfter.sources.length === 1 &&
    syncAfter.sources[0].id === 'xmgcn-timeline' && syncAfter.sources[0].internal === true);
  check('被拒的来源在健康信息里标得出来', syncAfter.sources[0].reason === 'SOURCE_BLOCKED');

  // 降级的用户侧来源（主源被拒、备源接管）不能被当成内部源 ——
  // 否则「来源变了」这句话就永远说不出口
  var health = notices.sourceHealth({
    results: [{
      sourceId: 'xmgcn',
      sourceName: '油价网',
      status: 'degraded',
      advisory: true,
      degraded: [{ regionCode: '440000' }, { regionCode: '370000' }]
    }]
  });
  check('降级的用户侧来源不被标成内部源', health[0].internal === false);
  check('降级省份数被记下来', health[0].degraded === 2, String(health[0].degraded));
  check('被备源接住的省份数单独记（没接住就是 0）', health[0].takenOver === 0, String(health[0].takenOver));
  check('降级的来源名能显示出来', health[0].name === '油价网', health[0].name);

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
