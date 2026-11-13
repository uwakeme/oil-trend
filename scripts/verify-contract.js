/**
 * 端到端契约自检：后端真实响应 → 前端页面渲染结果
 *
 * 为什么要有这个：
 *   现有自检都是「各数据源自证」——
 *   selftest.js 比的是 data/ 演示源 vs 服务端生成物（数值，不是接口结构），
 *   check-openapi.js 用 pg-mem 直插 approved 夹具（绕过了真实产出链路）。
 *   两边都盖不住「前端消费后端响应」这一层：
 *   字段名漂一个（latestNotice / notice）、空值当 0（0.00 元）、
 *   来源标错（演示数据说成实时），这些 bug 静态检查一个都查不出来。
 *
 * 本脚本做的事：
 *   1. 用 pg-mem 起真库、真灌数据、真起 Express，真发 HTTP 请求；
 *   2. 把 /api/home、/api/trend、/api/notices、/api/market 的**真实响应体**
 *      喂给小程序端五个页面的 applyXxx()；
 *   3. 断言渲染结果：关键字段非空、没有 undefined/NaN、
 *      来源标识与 source.mode 一致、空值不冒充 0.00。
 *
 * 用法：node scripts/verify-contract.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

/**
 * pg-mem 装在 server/ 下（server/package.json 的 devDependencies）。
 * 根目录没有 package.json，所以这里先试本仓库、再试服务端那份。
 */
function loadPgMem() {
  try {
    return require('pg-mem');
  } catch (e) {
    return require(path.join(SERVER, 'node_modules', 'pg-mem'));
  }
}
var newDb = loadPgMem().newDb;

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

/** 发一个 HTTP 请求 */
function request(port, method, path, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: method,
      headers: data ? { 'Content-Type': 'application/json' } : {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* 不是 JSON 就留 null */ }
        resolve({ status: res.statusCode, body: json, text: text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ---------------- 小程序运行时桩 ---------------- */

var storage = {};

global.wx = {
  getStorageSync: function (k) { return storage[k] === undefined ? '' : storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function () {},
  showModal: function () {},
  stopPullDownRefresh: function () {},
  switchTab: function () {},
  request: function () { return { abort: function () {} }; },
  login: function () {}
};

var capturedPage = null;
global.Page = function (def) { capturedPage = def; };
global.getApp = function () { return { globalData: {} }; };
global.Component = function () {};

/** 加载一个页面模块，返回它的 Page 定义 */
function loadPageDef(relPath) {
  capturedPage = null;
  var abs = path.join(ROOT, relPath);
  delete require.cache[require.resolve(abs)];
  require(abs);
  if (!capturedPage) throw new Error('页面没有调用 Page()：' + relPath);
  return capturedPage;
}

/** 造一个页面实例：带 data 深拷贝与 setData */
function makeInstance(def) {
  var inst = {};
  Object.keys(def).forEach(function (k) {
    if (k !== 'data') inst[k] = def[k];
  });
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  inst.setData = function (patch) {
    Object.keys(patch).forEach(function (k) { inst.data[k] = patch[k]; });
  };
  return inst;
}

/** 把对象里所有字符串拼起来，用于「有没有漏出 undefined / NaN」检查 */
function allText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(allText).join(' ');
  if (typeof value === 'object') return Object.keys(value).map(function (k) {
    return k + ' ' + allText(value[k]);
  }).join(' ');
  return '';
}

function hasBadToken(text) {
  return text.indexOf('undefined') >= 0 || text.indexOf('NaN') >= 0;
}

/* ---------------- 把后端响应喂给前端 ---------------- */

/**
 * 替换 utils/api.js 的实现，让页面拿到我们准备好的真实响应。
 * 只换这一个模块，其余（utils/format、utils/store、data/…）都是真的在跑。
 *
 * ⚠️ 直接改 module.exports 上的属性，不要重新编译模块 ——
 * JSON 序列化会把函数抹掉，页面拿到的是空对象。
 */
function stubApi(responses) {
  var api = require(path.join(ROOT, 'utils', 'api.js'));
  Object.keys(responses).forEach(function (k) {
    api[k] = responses[k];
  });
  return api;
}

async function main() {
  process.env.OIL_ALLOW_NO_DATABASE = '1';
  process.env.OIL_TOKEN_SECRET = 'contract-test-secret-0123456789abcdef';

  // ===== 后端：真库、真服务、真请求 =====
  var db = newDb();
  var adapter = db.adapters.createPg();
  var dbModule = require(path.join(SERVER, 'src', 'db.js'));
  var pgPool = new adapter.Pool();
  dbModule.pool.query = function (text, params) { return pgPool.query(text, params); };
  await db.public.query(fs.readFileSync(path.join(SERVER, 'schema.sql'), 'utf8'));

  var fixtures = require(path.join(SERVER, 'scripts', 'test-fixtures.js'));
  await fixtures.seed();

  // 造一条**可信**的正式通知：机器判定 approved 的那种
  var dao = require(path.join(SERVER, 'src', 'dao', 'index.js'));
  await dao.notices.insert({
    dedupKey: 'contract::2026-11-12::approved',
    kind: 'official',
    title: '国内成品油价格按机制下调',
    publishedAt: new Date().toISOString(),
    executeAt: '2026-11-12',
    changes: { '92': -0.08, '95': -0.09, '98': -0.1, '0': -0.08 },
    summary: '契约自检数据',
    prices: {},
    source: { name: '国家发展改革委价格监测中心', url: '' },
    reviewStatus: 'approved'
  });

  var createApp = require(path.join(SERVER, 'src', 'app.js')).createApp;
  var server = createApp().listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  var port = server.address().port;

  try {
    console.log('\n--- 取后端真实响应 ---');
    var homeRes = await request(port, 'GET', '/api/home?regionCode=440000');
    var trendRes = await request(port, 'GET', '/api/trend?regionCode=440000&fuelId=92&period=3m');
    var noticesRes = await request(port, 'GET', '/api/notices?regionCode=440000&filter=official');
    var marketRes = await request(port, 'GET', '/api/market?symbol=brent&period=1d');
    check('/api/home 返回 200', homeRes.status === 200);
    check('/api/trend 返回 200', trendRes.status === 200);
    check('/api/notices 返回 200', noticesRes.status === 200);
    check('/api/market 返回 200', marketRes.status === 200);

    var home = homeRes.body.data;
    var trend = trendRes.body.data;
    var noticeList = noticesRes.body.data;
    var market = marketRes.body.data;

    console.log('\n--- 后端契约本身 ---');
    check('home 同时给 notice 与 latestNotice（字段不漂移）',
      !!home.latestNotice && !!home.notice &&
      home.latestNotice.title === home.notice.title);
    check('home 带 updatedAt', typeof home.updatedAt === 'string');
    check('home 的窗口带 forecastDirection',
      typeof home.window.forecastDirection === 'string');
    check('home 的 forecast 是区间结构（不是按油品 id 的字典）',
      home.window.forecast && typeof home.window.forecast === 'object' &&
      !Array.isArray(home.window.forecast) &&
      (home.window.forecast.estimated === true || home.window.forecast.direction !== undefined));
    check('市场行情带 code', typeof market.code === 'string' && market.code.length > 0);
    check('市场行情带 delayMinutes 字段', 'delayMinutes' in market);
    check('市场行情 direction 是三态',
      ['up', 'down', 'flat'].indexOf(market.direction) >= 0);

    console.log('\n--- 前端消费后端响应 ---');
    stubApi({
      getHome: function () { return Promise.resolve(home); },
      getTrend: function () { return Promise.resolve(trend); },
      getNotices: function () { return Promise.resolve(noticeList); },
      getMarket: function () { return Promise.resolve(market); },
      getRegions: function () { return Promise.resolve({ regions: [] }); },
      getAlertRules: function () { return Promise.resolve([]); },
      getAlertHistory: function () { return Promise.resolve([]); },
      saveAlertRules: function (rules) { return Promise.resolve(rules); },
      locate: function () { return Promise.resolve({ error: 'no-backend' }); },
      sourceStatus: function () { return { mode: 'live', fellBack: false, reason: '' }; }
    });

    // 首页
    var indexPage = makeInstance(loadPageDef('pages/index/index.js'));
    await indexPage.load('440000');
    check('首页拿到价格', indexPage.data.prices.length === 4);
    check('首页通知标题非空', !!indexPage.data.notice.title,
      '实际：' + JSON.stringify(indexPage.data.notice.title));
    check('首页通知幅度不是 0.00（真数据不该冒充持平）',
      indexPage.data.notice.value !== '0.00', '实际：' + indexPage.data.notice.value);
    check('首页有来源提示条', !!indexPage.data.sourceText);
    check('首页来源不报警（真实数据）', indexPage.data.sourceWarn === false);
    check('首页更新时间不漏出 undefined', hasBadToken(indexPage.data.updatedLabel) === false,
      '实际：' + indexPage.data.updatedLabel);
    check('首页预测文案不漏出 undefined/NaN',
      hasBadToken(indexPage.data.forecast.text) === false, '实际：' + indexPage.data.forecast.text);
    check('首页预测不把未知说成持平',
      indexPage.data.forecast.text.indexOf('持平') < 0, '实际：' + indexPage.data.forecast.text);
    check('首页渲染里没有 undefined', hasBadToken(allText(indexPage.data)) === false);

    // 没有基线可比时（首次真实采集），涨跌额 0 是「未知」不是「持平」
    var noBaselineHome = JSON.parse(JSON.stringify(home));
    (noBaselineHome.prices || []).forEach(function (p) {
      p.changeAmount = 0;
      p.changeAt = '';
    });
    indexPage.applyHome(noBaselineHome);
    check('没有基线时不把未知显示成持平',
      indexPage.data.hero.changeText.indexOf('持平') < 0 &&
      indexPage.data.hero.changeText.indexOf('暂无') >= 0,
      '实际：' + indexPage.data.hero.changeText);
    check('没有基线时其余油品也不冒充持平',
      indexPage.data.prices.every(function (p) { return p.changeText.indexOf('持平') < 0; }),
      indexPage.data.prices.map(function (p) { return p.changeText; }).join(' / '));

    // 窗口已经过去（来源还没公布下一轮）：不能再写「下一次…距窗口 -1 天」
    var expiredHome = JSON.parse(JSON.stringify(home));
    expiredHome.window = Object.assign({}, expiredHome.window || {}, { daysLeft: -1 });
    indexPage.applyHome(expiredHome);
    check('窗口过期时标题改成上一轮',
      indexPage.data.window.titleText === '上一轮调价窗口', indexPage.data.window.titleText);
    check('窗口过期时不显示负数倒计时',
      indexPage.data.window.daysLeft === -1 && indexPage.data.window.passedDays === 1,
      String(indexPage.data.window.daysLeft));
    check('窗口过期时不挂失效的预测',
      indexPage.data.forecast.text.indexOf('预计') < 0, indexPage.data.forecast.text);

    // 调价页
    var noticePage = makeInstance(loadPageDef('pages/notice/notice.js'));
    await noticePage.load();
    check('调价页拿到通知', noticePage.data.notices.length > 0);
    check('调价页通知标题非空', !!noticePage.data.notices[0].title);
    check('调价页有来源提示条', !!noticePage.data.sourceText);
    check('调价页渲染里没有 undefined', hasBadToken(allText(noticePage.data)) === false);

    // 走势页
    var trendPage = makeInstance(loadPageDef('pages/trend/trend.js'));
    await trendPage.load();
    check('走势页价格不是 --（后端有数据）', trendPage.data.priceText !== '--',
      '实际：' + trendPage.data.priceText);
    check('走势页有来源提示条', !!trendPage.data.sourceText);
    check('走势页事件带 date（wx:key 指向的字段真实存在）',
      trendPage.data.events.every(function (e) { return !!e.date; }));
    check('走势页事件 direction 是三态',
      trendPage.data.events.every(function (e) {
        return ['up', 'down', 'flat'].indexOf(e.direction) >= 0;
      }));
    check('走势页渲染里没有 undefined', hasBadToken(allText(trendPage.data)) === false);

    // 国际页
    var globalPage = makeInstance(loadPageDef('pages/global/global.js'));
    await globalPage.load();
    check('国际页价格不是 --', globalPage.data.market.priceText !== '--',
      '实际：' + globalPage.data.market.priceText);
    check('国际页延时文案不漏出 undefined',
      hasBadToken(globalPage.data.delayText) === false, '实际：' + globalPage.data.delayText);
    check('国际页品种代码非空', !!globalPage.data.market.code);
    check('国际页有来源提示条', !!globalPage.data.sourceText);
    check('国际页渲染里没有 undefined', hasBadToken(allText(globalPage.data)) === false);

    // 提醒页
    var alertPage = makeInstance(loadPageDef('pages/alert/alert.js'));
    await alertPage.load();
    check('提醒页有来源标注（以前完全没有）', !!alertPage.data.sourceText,
      '实际：' + alertPage.data.sourceText);
    check('提醒页当前价不是 --', alertPage.data.currentPriceText !== '--',
      '实际：' + alertPage.data.currentPriceText);
    check('提醒页渲染里没有 undefined', hasBadToken(allText(alertPage.data)) === false);

    console.log('\n--- 空值不许冒充 0.00 ---');
    var fmt = require(path.join(ROOT, 'utils', 'format.js'));
    check('fmt.price(null) 是 --', fmt.price(null) === '--');
    check('fmt.price(undefined) 是 --', fmt.price(undefined) === '--');
    check("fmt.price('') 是 --", fmt.price('') === '--');
    check('fmt.price(0) 仍然是 0.00（0 是真实价格）', fmt.price(0) === '0.00');
    check('fmt.priceValue(null) 是 null（区别于 0）', fmt.priceValue(null) === null);
    check('fmt.priceValue(0) 是 0', fmt.priceValue(0) === 0);

    // 空价格喂给首页：不能渲染成 0.00
    stubApi({
      getHome: function () {
        return Promise.resolve(Object.assign({}, home, {
          prices: [],
          latestNotice: { id: 1, title: '', executeAt: '', changes: {} }
        }));
      },
      getTrend: function () { return Promise.resolve(trend); },
      getNotices: function () { return Promise.resolve(noticeList); },
      getMarket: function () { return Promise.resolve(market); },
      getRegions: function () { return Promise.resolve({ regions: [] }); },
      getAlertRules: function () { return Promise.resolve([]); },
      getAlertHistory: function () { return Promise.resolve([]); },
      saveAlertRules: function (rules) { return Promise.resolve(rules); },
      locate: function () { return Promise.resolve({ error: 'no-backend' }); },
      sourceStatus: function () { return { mode: 'live', fellBack: false, reason: '' }; }
    });
    var emptyPage = makeInstance(loadPageDef('pages/index/index.js'));
    await emptyPage.load('440000');
    check('空价格不渲染成 0.00',
      allText(emptyPage.data).indexOf('0.00') < 0, '实际：' + allText(emptyPage.data).slice(0, 200));
    check('空通知标题不漏出 undefined', hasBadToken(allText(emptyPage.data)) === false);

    console.log('\n--- 汇总 ---');
    console.log('检查 ' + checks + ' 项，失败 ' + failures.length + ' 项');
    if (failures.length) {
      failures.forEach(function (f) { console.log('  ✗ ' + f); });
      process.exitCode = 1;
    } else {
      console.log('全部通过。');
    }
  } finally {
    server.close();
  }
}

main().catch(function (err) {
  console.error('\n契约自检异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});