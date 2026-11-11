/**
 * HTTP 层自检：真起一个 Express 服务，用真请求打真接口。
 *
 * 与 selftest.js 的分工：
 *   selftest.js  验「返回结构对不对」（直接调 service）
 *   本脚本      验「HTTP 层通不通」（真起服务、真发请求）
 *
 * 数据库用 pg-mem 顶替，重点是路由、响应外壳、认证拦截。
 *
 * 用法：node scripts/http-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
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

/** 发一个 HTTP 请求 */
function request(port, method, path, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: method,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}
      )
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
  process.env.OIL_TOKEN_SECRET = 'test-secret';

  // 内存库
  var db = newDb();
  var adapter = db.adapters.createPg();
  var dbModule = require(path.join(ROOT, 'src', 'db.js'));
  var pgPool = new adapter.Pool();
  dbModule.pool.query = function (text, params) { return pgPool.query(text, params); };
  await db.public.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

  // 灌演示数据
  var collector = require(path.join(ROOT, 'src', 'services', 'collector.js'));
  await collector.seed();

  // 起服务
  var { createApp } = require(path.join(ROOT, 'src', 'app.js'));
  var server = createApp().listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  var port = server.address().port;
  console.log('测试服务已起，端口 ' + port);

  try {
    console.log('\n--- 基础 ---');
    var health = await request(port, 'GET', '/health');
    check('健康检查返回 200', health.status === 200);
    check('健康检查用统一外壳', health.body && health.body.ok === true);

    var notFound = await request(port, 'GET', '/api/nope');
    check('未知路径返回 404', notFound.status === 404);
    check('未知路径也是 JSON 外壳', notFound.body && notFound.body.ok === false);

    console.log('\n--- 查询接口 ---');
    var regions = await request(port, 'GET', '/api/regions');
    check('GET /api/regions 返回 200', regions.status === 200);
    check('regions 外壳正确', regions.body && regions.body.ok === true);
    check('regions 有 10 个地区', regions.body.data.regions.length === 10);

    var home = await request(port, 'GET', '/api/home?regionCode=440000');
    check('GET /api/home 返回 200', home.status === 200);
    check('home 有 prices', home.body.data.prices.length === 4);
    check('home 有 window', !!home.body.data.window);

    var trend = await request(port, 'GET', '/api/trend?regionCode=440000&fuelId=92&period=3m');
    check('GET /api/trend 返回 200', trend.status === 200);
    check('trend 有 points', trend.body.data.points.length > 0);

    var notices = await request(port, 'GET', '/api/notices?regionCode=440000&filter=official');
    check('GET /api/notices 返回 200', notices.status === 200);
    check('notices 有 sync 状态', typeof notices.body.data.sync.status === 'string');

    var market = await request(port, 'GET', '/api/market?symbol=brent&period=1d');
    check('GET /api/market 返回 200', market.status === 200);
    check('market 有 points', market.body.data.points.length > 0);

    var sync = await request(port, 'GET', '/api/sync-status');
    check('GET /api/sync-status 返回 200', sync.status === 200);
    check('sync-status 有 status', typeof sync.body.data.status === 'string');

    console.log('\n--- 认证拦截 ---');
    var noAuth = await request(port, 'GET', '/api/rules');
    check('未带 token 访问 /api/rules 返回 401', noAuth.status === 401);
    check('401 用统一外壳', noAuth.body && noAuth.body.ok === false && noAuth.body.code === 'UNAUTHORIZED');

    var badToken = await request(port, 'GET', '/api/rules', null, { Authorization: 'Bearer garbage' });
    check('错误 token 返回 401', badToken.status === 401);

    console.log('\n--- 登录 ---');
    var login = await request(port, 'POST', '/api/login', { code: 'test-code' });
    // 微信接口没真调（没配 AppSecret），这里只验「请求被正确接收并返回明确错误」
    check('登录缺配置时返回 ok:false（不是 500）', login.body && login.body.ok === false);
    check('登录错误带 code', !!(login.body && login.body.code));

    var noCode = await request(port, 'POST', '/api/login', {});
    check('登录缺 code 返回明确错误', noCode.body && noCode.body.ok === false && noCode.body.code === 'NO_CODE');

    console.log('\n--- 带 token 访问 ---');
    // 用服务端自己的签发函数造一个合法 token
    var auth = require(path.join(ROOT, 'src', 'services', 'auth.js'));
    var token = auth.issueToken('openid-test');
    var withAuth = await request(port, 'GET', '/api/rules', null, { Authorization: 'Bearer ' + token });
    check('带合法 token 返回 200', withAuth.status === 200);
    check('rules 返回数组', Array.isArray(withAuth.body.data.rules));

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
  console.error('\nHTTP 自检异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
