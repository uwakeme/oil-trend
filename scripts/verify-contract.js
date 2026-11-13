/**
 * 端到端契约自检：后端真实响应 → 前端真实取数链路 → 页面渲染结果
 *
 * 为什么要有这个：
 *   现有自检都是「各数据源自证」——
 *   selftest.js 比的是 data/ 演示源 vs 服务端生成物（数值，不是接口结构），
 *   check-openapi.js 用 pg-mem 直插 approved 夹具（绕过了真实产出链路）。
 *   两边都盖不住「前端消费后端响应」这一层：
 *   字段名漂一个（latestNotice / notice）、空值当 0（0.00 元）、
 *   来源标错（演示数据说成实时），这些 bug 静态检查一个都查不出来。
 *
 * ⚠️ 上一版的做法是错的（复审 R1-1）：
 *   stubApi() 直接覆盖 utils/api.js 的 module.exports，
 *   于是 fetchWithFallback / hasExpected / stampSource **一次都没跑过**；
 *   通知还是手插 reviewStatus:'approved' 夹具，把整条机器判定链路绕开了。
 *   那样测出来的「契约一致」是假的一致 —— 字段漂了也照样全绿。
 *
 * 这一版做的事：
 *   1. pg-mem 起真库、真灌数据、真起 Express，真发 HTTP 请求；
 *   2. wx.request 桩**把请求转发到本地测试服务**（只换 origin），
 *      utils/cloud.js 与 utils/api.js 一行不改地真跑：
 *      action→路径映射、超时、错误分支、来源归一、回落演示源全是真的；
 *   3. 正式通知由**采集链路**产出：
 *      sources.PARSERS.ndrcNotice(正文) → collector.saveNotice →
 *      机器判定 review_status → 对外可见性。不再手插 approved 夹具；
 *   4. 把真实响应喂给小程序端五个页面的 applyXxx()，断言渲染结果。
 *
 * 用法：node scripts/verify-contract.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL, URLSearchParams } = require('url');

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

/** 契约自检用的固定 openid（token 由服务端本地签发，不需要微信） */
var TEST_OPENID = 'contract-test-openid';

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

/* ---------------- 公告正文夹具 ---------------- */

/**
 * 公告正文夹具。
 *
 * ⚠️ 这几条按发改委公告的**真实写法**构造，
 * 覆盖上一版解析器判错的几类情况（复审 R0-2）：
 *   approved —— 逐项列明 + 共用一个幅度 + 执行日期明确 → 应当 approved
 *   ambiguous —— 只写「调整」，看不出上调还是下调 → 应当 pending
 *   partial  —— 只列了两个油品 → 应当 pending（不能替公告补上缺的幅度）
 */
var NOTICE_TEXT = {
  approved:
    '国家发展改革委价格监测中心消息，国内成品油价格按机制下调：' +
    '92号汽油、95号汽油、98号汽油每升下调0.10元，0号柴油每升下调0.08元。' +
    '自2026年11月24日24时起执行。',
  ambiguous:
    '关于成品油价格调整的公告：92号汽油、95号汽油、98号汽油每升调整0.10元，' +
    '0号柴油每升调整0.08元。自2026年11月25日24时起执行。',
  partial:
    '国内成品油价格按机制下调：92号汽油每升下调0.10元，95号汽油每升下调0.10元。' +
    '自2026年11月26日24时起执行。'
};

/* ---------------- 小程序运行时桩 ---------------- */

var storage = {};

/**
 * 传输层控制。
 *
 * delayRegion / delayMs：给指定地区的响应加延迟，用来复现「先发的请求后到」的竞态。
 */
var transport = {
  port: 0,
  delayRegion: '',
  delayMs: 0
};

/**
 * 发一个真实的 HTTP 请求到本地测试服务。
 *
 * ⚠️ 这不是「假装成功」的桩：请求真的发出去、真的收响应，
 * 状态码与响应体都按微信小程序的形式交给上层。
 * 唯一的差别是 origin 被换成了 127.0.0.1 ——
 * 相当于把后端部署在本机来测。
 */
function wxRequest(opts) {
  var done = false;
  var req = null;

  function succeed(res) {
    if (done) return;
    done = true;
    if (opts.success) opts.success(res);
  }
  function fail(err) {
    if (done) return;
    done = true;
    if (opts.fail) opts.fail(err);
  }

  var url = new URL(opts.url);
  var method = (opts.method || 'GET').toUpperCase();
  var payload = opts.data || {};
  var query = '';
  var body = null;

  if (method === 'GET') {
    // 小程序的 wx.request 在 GET 时把 data 拼到 query 上
    var qs = new URLSearchParams();
    Object.keys(payload).forEach(function (k) {
      var v = payload[k];
      if (v === undefined || v === null || v === '') return;
      qs.append(k, String(v));
    });
    query = qs.toString();
  } else {
    body = JSON.stringify(payload);
  }
  var target = url.pathname + (query ? ('?' + query) : '');

  // /api/login 是唯一的例外：code 换 openid 要真调微信 code2session，
  // 那需要正式 AppID + AppSecret，契约自检没有这些凭据。
  // 在传输层换成本地签发的 token，其余环节
  // （Authorization 头、requireAuth 中间件、真实用户数据）都是真的。
  if (target === '/api/login') {
    var auth = require(path.join(SERVER, 'src', 'services', 'auth.js'));
    setTimeout(function () {
      succeed({
        statusCode: 200,
        data: { ok: true, data: { token: auth.issueToken(TEST_OPENID), openid: TEST_OPENID } },
        header: {}
      });
    }, 0);
    return { abort: function () {} };
  }

  var headers = Object.assign({}, opts.header || {});
  if (body) headers['Content-Length'] = Buffer.byteLength(body);

  req = http.request({
    hostname: '127.0.0.1',
    port: transport.port,
    path: target,
    method: method,
    headers: headers,
    // 不用 keep-alive：后面要真的把服务关掉来测「后端不可达」
    agent: false
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var text = Buffer.concat(chunks).toString('utf8');
      var data;
      try { data = JSON.parse(text); } catch (e) { data = text; }
      var payload = {
        statusCode: res.statusCode,
        data: data,
        header: res.headers
      };
      var delay = 0;
      if (transport.delayMs && transport.delayRegion &&
        target.indexOf('regionCode=' + transport.delayRegion) >= 0) {
        delay = transport.delayMs;
      }
      if (delay) setTimeout(function () { succeed(payload); }, delay);
      else succeed(payload);
    });
  });
  req.on('error', function (err) {
    fail({ errMsg: 'request:fail ' + (err && err.message ? err.message : String(err)) });
  });
  if (body) req.write(body);
  req.end();

  return {
    abort: function () {
      try { req.destroy(); } catch (e) { /* 已经结束了 */ }
    }
  };
}

global.wx = {
  getStorageSync: function (k) { return storage[k] === undefined ? '' : storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function () {},
  showModal: function () {},
  stopPullDownRefresh: function () {},
  switchTab: function () {},
  setClipboardData: function () {},
  // 模拟 wx.login：给一个一次性 code，code→token 的兑换在传输层完成
  login: function (opts) {
    if (opts && opts.success) opts.success({ code: 'contract-login-code' });
  },
  request: wxRequest
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

/** 发一个 HTTP 请求（脚本自己查后端用） */
function request(port, method, target, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: target,
      method: method,
      headers: data ? { 'Content-Type': 'application/json' } : {},
      agent: false
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

  var dao = require(path.join(SERVER, 'src', 'dao', 'index.js'));
  var shared = require(path.join(SERVER, 'src', 'shared', 'shared.js'));
  var sources = require(path.join(SERVER, 'src', 'services', 'sources.js'));
  var collector = require(path.join(SERVER, 'src', 'services', 'collector.js'));
  var ndrcSource = sources.SOURCES.filter(function (s) { return s.id === 'ndrc-notice'; })[0];

  var createApp = require(path.join(SERVER, 'src', 'app.js')).createApp;
  var server = createApp().listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  var port = server.address().port;
  transport.port = port;

  // 只在本测试里存在的公告源：把公告正文吐出来。
  //
  // ⚠️ 采集链路整条都是真的（真发 HTTP → 真解析 → 真入库 → 真判可信度），
  // 只是把「发改委站点」换成本机 —— 不打真实站点，也不会被限流。
  // 单独起一个服务，不塞进业务 app：那个 app 的 404 兜底是注册在最前面的
  // use 中间件，塞进去的路由根本轮不到。
  var noticeServer = http.createServer(function (req, res) {
    var key = '';
    var m = String(req.url || '').match(/[?&]text=([^&]*)/);
    if (m) key = decodeURIComponent(m[1]);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(NOTICE_TEXT[key] || NOTICE_TEXT.approved);
  });
  await new Promise(function (r) { noticeServer.listen(0, '127.0.0.1', r); });
  var noticePort = noticeServer.address().port;

  try {
    /* ===== 一、通知由采集链路产出（复审 R0-2） ===== */
    console.log('\n--- 公告解析与机器判定 ---');
    var parsedApproved = sources.PARSERS.ndrcNotice(NOTICE_TEXT.approved);
    var parsedAmbiguous = sources.PARSERS.ndrcNotice(NOTICE_TEXT.ambiguous);
    var parsedPartial = sources.PARSERS.ndrcNotice(NOTICE_TEXT.partial);

    check('逐项列明 + 日期明确的公告判为 approved',
      parsedApproved.reviewStatus === 'approved', parsedApproved.reviewStatus);
    check('四个油品的幅度都解析出来了（不能只认最后一个）',
      Object.keys(parsedApproved.deltas).length === 4,
      JSON.stringify(parsedApproved.deltas));
    check('共用一个幅度时三个汽油标号都拿到幅度',
      parsedApproved.deltas['92'] === -0.10 &&
      parsedApproved.deltas['95'] === -0.10 &&
      parsedApproved.deltas['98'] === -0.10,
      JSON.stringify(parsedApproved.deltas));
    check('柴油标号没被 98# 抢走',
      parsedApproved.deltas['0'] === -0.08, JSON.stringify(parsedApproved.deltas));
    check('中性词「调整」判为 pending（不能猜方向）',
      parsedAmbiguous.reviewStatus === 'pending', parsedAmbiguous.reviewStatus);
    check('只列两个油品的公告判为 pending（不能替公告补幅度）',
      parsedPartial.reviewStatus === 'pending', parsedPartial.reviewStatus);


    console.log('\n--- 采集链路：正文 → 抓取 → 解析 → 入库 → 可信度 ---');
    /**
     * 造一个指向本机公告源的 source。
     *
     * ⚠️ 走的是真的 collectFromSource —— 真发 HTTP、真解析、真入库、真判可信度。
     * 复审点名的「最该补的一条测试」就是这条：
     * 夹具正文 → 采集链路 → 入库 review_status → 对外可见性。
     */
    function noticeSource(text) {
      return Object.assign({}, ndrcSource, {
        enabled: true,
        url: 'http://127.0.0.1:' + noticePort + '/ndrc-notice?text=' + text
      });
    }

    var collectApproved = await collector.collectFromSource(noticeSource('approved'), {});
    check('逐项齐全的公告采集结果是 ok',
      collectApproved.status === 'ok', JSON.stringify(collectApproved));
    var collectAmbiguous = await collector.collectFromSource(noticeSource('ambiguous'), {});
    check('存疑公告进人工核对队列（status=needsReview）',
      collectAmbiguous.status === 'needsReview', JSON.stringify(collectAmbiguous));
    check('存疑公告的原因是 NOTICE_PENDING（不是抓取或解析失败）',
      collectAmbiguous.reason === 'NOTICE_PENDING', collectAmbiguous.reason);
    var collectPartial = await collector.collectFromSource(noticeSource('partial'), {});
    check('只列两个油品的公告同样进人工核对队列',
      collectPartial.status === 'needsReview', JSON.stringify(collectPartial));

    var approvedKey = shared.dedupKey(ndrcSource.id, parsedApproved.title, parsedApproved.executeAt);
    var approvedRow = await dao.notices.findByDedupKey(approvedKey);
    check('可信公告入库 review_status=approved',
      !!approvedRow && approvedRow.reviewStatus === 'approved',
      approvedRow ? approvedRow.reviewStatus : '没找到这条');
    check('可信公告的摘要写明逐项列明',
      !!approvedRow && approvedRow.summary.indexOf('逐项列明') >= 0,
      approvedRow ? approvedRow.summary : '');

    var pendingKey = shared.dedupKey(ndrcSource.id, parsedPartial.title, parsedPartial.executeAt);
    var pendingRow = await dao.notices.findByDedupKey(pendingKey);
    check('存疑公告落在库里，但 review_status 是 pending',
      !!pendingRow && pendingRow.reviewStatus === 'pending',
      pendingRow ? pendingRow.reviewStatus : '没找到这条');
    check('存疑公告的摘要不谎称「逐项列明」',
      !!pendingRow && pendingRow.summary.indexOf('逐项列明') < 0,
      pendingRow ? pendingRow.summary : '');

    console.log('\n--- 采集运行记录：存疑要进 needsReview 队列 ---');
    // 临时把采集源换成只跑本机的 ndrc —— 别去真打 qiyoujiage。
    var qyjSource = sources.SOURCES.filter(function (s) { return s.id === 'qiyoujiage'; })[0];
    var qyjEnabled = qyjSource.enabled;
    var ndrcIndex = sources.SOURCES.indexOf(ndrcSource);
    qyjSource.enabled = false;
    sources.SOURCES[ndrcIndex] = noticeSource('ambiguous');
    var runDoc = await collector.run({});
    sources.SOURCES[ndrcIndex] = ndrcSource;
    qyjSource.enabled = qyjEnabled;

    check('采集运行记录里有需要人工核对的条目',
      runDoc.needsReview.length > 0, JSON.stringify(runDoc.needsReview));
    check('运行状态不是「同步正常」', runDoc.status !== 'ok', runDoc.status);
    check('needsReview 里说明了是公告存疑',
      runDoc.needsReview.some(function (n) { return n.reason === 'NOTICE_PENDING'; }),
      JSON.stringify(runDoc.needsReview));

    /* ===== 二、后端接口自身 ===== */
    console.log('\n--- 后端真实响应 ---');
    var homeRes = await request(port, 'GET', '/api/home?regionCode=440000');
    var trendRes = await request(port, 'GET', '/api/trend?regionCode=440000&fuelId=92&period=3m');
    var noticesRes = await request(port, 'GET', '/api/notices?regionCode=440000&filter=official');
    var marketRes = await request(port, 'GET', '/api/market?symbol=brent&period=1d');
    var badRegionRes = await request(port, 'GET', '/api/home?regionCode=999999');
    check('/api/home 返回 200', homeRes.status === 200);
    check('/api/trend 返回 200', trendRes.status === 200);
    check('/api/notices 返回 200', noticesRes.status === 200);
    check('/api/market 返回 200', marketRes.status === 200);
    check('非法地区返回 4xx（错误不能再一律 200）',
      badRegionRes.status >= 400 && badRegionRes.status < 500, String(badRegionRes.status));
    check('错误响应保留 { ok, message, code } 外壳',
      badRegionRes.body && badRegionRes.body.ok === false &&
      typeof badRegionRes.body.message === 'string' &&
      typeof badRegionRes.body.code === 'string',
      JSON.stringify(badRegionRes.body));

    var home = homeRes.body.data;
    var trend = trendRes.body.data;
    var noticeList = noticesRes.body.data;
    var market = marketRes.body.data;

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

    console.log('\n--- 对外可见性：存疑公告不发布 ---');
    // ⚠️ 按执行日期区分，不能按标题：标题是从正文正则匹配的，
    // 措辞一样的两条公告标题当然会撞 —— 拿标题当主键会误判。
    var publicDates = (noticeList.notices || []).map(function (n) {
      return String(n.executeAt || '').slice(0, 10);
    });
    check('可信公告出现在对外列表里',
      publicDates.indexOf(parsedApproved.executeAt) >= 0, JSON.stringify(publicDates));
    check('存疑公告没有出现在对外列表里',
      publicDates.indexOf(parsedPartial.executeAt) < 0, JSON.stringify(publicDates));

    /* ===== 三、前端走真实取数链路 ===== */
    console.log('\n--- 前端消费后端响应（走真实 api 层） ---');
    // 让 utils/cloud.js 认定后端已配置 —— 之后 api.js 才会真走后端
    var cloud = require(path.join(ROOT, 'utils', 'cloud.js'));
    cloud.initCloud({});

    var indexPage = makeInstance(loadPageDef('pages/index/index.js'));
    await indexPage.load('440000');

    check('首页拿到价格', indexPage.data.prices.length === 4,
      '实际：' + indexPage.data.prices.length);
    check('首页通知标题非空', !!indexPage.data.notice.title,
      '实际：' + JSON.stringify(indexPage.data.notice.title));
    check('首页通知标题就是采集链路产出的那条',
      indexPage.data.notice.title === parsedApproved.title,
      indexPage.data.notice.title);
    check('首页通知幅度不是 0.00（真数据不该冒充持平）',
      indexPage.data.notice.value !== '0.00', '实际：' + indexPage.data.notice.value);
    check('首页通知不是空态（有正式公告）', indexPage.data.notice.empty === false);
    check('首页有来源提示条', !!indexPage.data.sourceText);
    // ⚠️ 这条是「api 层真的跑过」的证据：
    // 后端给的 mode 是 'server'，只有 stampSource 归一成 'live' 才会是这句文案。
    // 页面直接吃后端原始响应时这里是「数据来源待确认」。
    check('来源被归一成 live（说明 fetchWithFallback/stampSource 真跑了）',
      indexPage.data.sourceText === '真实数据 · 服务端定时采集',
      indexPage.data.sourceText);
    check('首页来源不报警（真实数据）', indexPage.data.sourceWarn === false);
    check('首页来源名不暴露内部来源名',
      indexPage.data.sourceName === '服务端采集数据', indexPage.data.sourceName);
    check('首页状态条说明来自服务端采集',
      indexPage.data.cloudStatus === '本次数据来自服务端采集', indexPage.data.cloudStatus);
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
    check('调价页只显示可信公告',
      noticePage.data.notices.every(function (n) {
        return String((n.raw || {}).executeAt || '').slice(0, 10) !== parsedPartial.executeAt;
      }),
      noticePage.data.notices.map(function (n) {
        return String((n.raw || {}).executeAt || '').slice(0, 10);
      }).join(' / '));
    check('调价页有来源提示条', !!noticePage.data.sourceText);
    check('调价页来源是真实数据',
      noticePage.data.sourceText === '真实数据 · 服务端定时采集', noticePage.data.sourceText);
    check('采集有存疑条目时同步状态显示「等待人工核对」',
      noticePage.data.sync.statusText === '等待人工核对', noticePage.data.sync.statusText);
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
    check('提醒页来源是真实数据',
      alertPage.data.sourceText.indexOf('真实数据') >= 0, alertPage.data.sourceText);
    check('提醒页当前价不是 --', alertPage.data.currentPriceText !== '--',
      '实际：' + alertPage.data.currentPriceText);
    check('提醒页渲染里没有 undefined', hasBadToken(allText(alertPage.data)) === false);

    /* ===== 四、空值不许冒充 0.00 ===== */
    console.log('\n--- 空值不许冒充 0.00 ---');
    var fmt = require(path.join(ROOT, 'utils', 'format.js'));
    check('fmt.price(null) 是 --', fmt.price(null) === '--');
    check('fmt.price(undefined) 是 --', fmt.price(undefined) === '--');
    check("fmt.price('') 是 --", fmt.price('') === '--');
    check('fmt.price(0) 仍然是 0.00（0 是真实价格）', fmt.price(0) === '0.00');
    check('fmt.priceValue(null) 是 null（区别于 0）', fmt.priceValue(null) === null);
    check('fmt.priceValue(0) 是 0', fmt.priceValue(0) === 0);

    /* ===== 五、后端「合法为空」不该回落演示源 ===== */
    console.log('\n--- 合法为空：显示空态，不回落演示数据 ---');
    // 模拟「这个地区还没采到挂牌价」：把该地区的当前价删掉
    await dbModule.pool.query('DELETE FROM oil_prices WHERE region_code = $1', ['440000']);
    var emptyPage = makeInstance(loadPageDef('pages/index/index.js'));
    await emptyPage.load('440000');
    check('没采到价时首页进入空态', emptyPage.data.dataEmpty === true);
    check('没采到价时不显示 0.00 的假价格',
      allText(emptyPage.data).indexOf('0.00') < 0, allText(emptyPage.data).slice(0, 200));
    check('没采到价时来源仍是真实数据（没有回落演示源）',
      emptyPage.data.sourceText === '真实数据 · 服务端定时采集',
      emptyPage.data.sourceText);
    check('没采到价时不报警', emptyPage.data.sourceWarn === false);
    // 还原价格，后面的用例还要用
    await fixtures.seed();

    /* ===== 六、后端不可达时回落演示源 ===== */
    console.log('\n--- 后端不可达：如实回落演示数据 ---');
    await new Promise(function (r) {
      server.close(r);
      if (server.closeAllConnections) server.closeAllConnections();
    });
    var fallbackPage = makeInstance(loadPageDef('pages/index/index.js'));
    await fallbackPage.load('440000');
    check('后端挂了仍然有数据（回落演示源）', fallbackPage.data.prices.length === 4,
      '实际：' + fallbackPage.data.prices.length);
    check('回落时来源要报警', fallbackPage.data.sourceWarn === true);
    check('回落时说明用的是演示数据',
      fallbackPage.data.sourceText.indexOf('演示数据') >= 0, fallbackPage.data.sourceText);
    check('回落时状态条不谎称服务端采集',
      fallbackPage.data.cloudStatus.indexOf('演示数据') >= 0, fallbackPage.data.cloudStatus);
    check('回落时来源名是演示数据集',
      fallbackPage.data.sourceName === '演示数据集', fallbackPage.data.sourceName);
    check('回落时渲染里没有 undefined', hasBadToken(allText(fallbackPage.data)) === false);
    // 重新起服务，后面的用例还要用
    await new Promise(function (r) { server.listen(port, r); });

    /* ===== 七、竞态：先发后到的旧请求不能盖掉新结果 ===== */
    console.log('\n--- 竞态保护 ---');
    var racePage = makeInstance(loadPageDef('pages/index/index.js'));
    transport.delayRegion = '440000';
    transport.delayMs = 150;
    var slow = racePage.load('440000');
    var fast = racePage.load('510000');
    await Promise.all([slow, fast]);
    transport.delayRegion = '';
    transport.delayMs = 0;
    check('慢的旧请求后到也不能盖掉新结果',
      racePage.data.region && racePage.data.region.code === '510000',
      racePage.data.region ? racePage.data.region.code : JSON.stringify(racePage.data.region));

    /* ===== 八、生命周期：切走时复位弹层 ===== */
    console.log('\n--- 生命周期 ---');
    var sheetPage = makeInstance(loadPageDef('pages/index/index.js'));
    sheetPage.setData({ sheetType: 'notice' });
    var seqBefore = sheetPage._reqSeq;
    sheetPage.onHide();
    check('切走时弹层状态复位', sheetPage.data.sheetType === '');
    check('切走时不清请求序号（否则切回来会重复取数）',
      sheetPage._reqSeq === seqBefore, String(sheetPage._reqSeq));

    var noticeSheetPage = makeInstance(loadPageDef('pages/notice/notice.js'));
    noticeSheetPage.setData({ sheetVisible: true });
    noticeSheetPage.onHide();
    check('调价页切走时也复位弹层', noticeSheetPage.data.sheetVisible === false);

    var store = require(path.join(ROOT, 'utils', 'store.js'));
    store.setRegion('510000', 'manual');
    var keepPage = makeInstance(loadPageDef('pages/index/index.js'));
    keepPage.setData({ sheetType: 'city' });
    keepPage.onHide();
    check('切走时不清用户已选的地区',
      store.getPrefs().regionCode === '510000', store.getPrefs().regionCode);

    console.log('\n--- 汇总 ---');
    console.log('检查 ' + checks + ' 项，失败 ' + failures.length + ' 项');
    if (failures.length) {
      failures.forEach(function (f) { console.log('  ✗ ' + f); });
      process.exitCode = 1;
    } else {
      console.log('全部通过。');
    }
  } finally {
    await new Promise(function (r) {
      server.close(r);
      if (server.closeAllConnections) server.closeAllConnections();
    });
    if (noticeServer) {
      await new Promise(function (r) { noticeServer.close(r); });
    }
  }
}

main().catch(function (err) {
  console.error('\n契约自检异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
