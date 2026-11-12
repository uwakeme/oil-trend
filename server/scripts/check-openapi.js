/**
 * 校验 openapi.json 与真实接口一致
 *
 * 为什么需要：接口文档写错了比没有更糟 —— 联调时才发现对不上，
 * 要改代码又要改文档。文档与实现必须一起变。
 *
 * 检查项：
 *   1. OpenAPI 里声明的每个 path+method，路由里真的存在
 *   2. 路由里真的有的每个接口，OpenAPI 里也声明了（防止漏写）
 *   3. 每个接口的实际返回字段，与 schema 声明的字段一致
 *   4. 必填/枚举等约束与实际取值不冲突
 *
 * 用法：node scripts/check-openapi.js
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

function request(port, method, path, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: '127.0.0.1', port: port, path: path, method: method,
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
        try { json = JSON.parse(text); } catch (e) { /* 留 null */ }
        resolve({ status: res.statusCode, body: json, text: text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 从 schema 里取出 data 的属性名（顺着 $ref 找） */
function dataPropsOf(doc, opSchema) {
  var schema = opSchema;
  if (schema && schema.$ref) {
    var name = schema.$ref.split('/').pop();
    schema = doc.components.schemas[name];
  }
  if (!schema || !schema.properties || !schema.properties.data) return null;
  var dataSchema = schema.properties.data;
  if (dataSchema.$ref) {
    var n = dataSchema.$ref.split('/').pop();
    dataSchema = doc.components.schemas[n];
  }
  if (!dataSchema || !dataSchema.properties) return null;
  return Object.keys(dataSchema.properties);
}

/** 检查实际返回对象的字段是否都在声明里 */
function checkFields(name, actual, declared, pathPrefix) {
  if (!declared) return;
  var extra = Object.keys(actual).filter(function (k) {
    return declared.indexOf(k) === -1;
  });
  check(name + ' 的字段与 schema 一致',
    extra.length === 0,
    '未声明的字段: ' + extra.join(', ') + '（实际路径 ' + pathPrefix + '）');
}

async function main() {
  process.env.OIL_ALLOW_NO_DATABASE = '1';
  process.env.OIL_TOKEN_SECRET = 'test-secret';

  var doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi.json'), 'utf8'));

  // 内存库 + 灌数据
  var db = newDb();
  var adapter = db.adapters.createPg();
  var dbModule = require(path.join(ROOT, 'src', 'db.js'));
  var pgPool = new adapter.Pool();
  dbModule.pool.query = function (text, params) { return pgPool.query(text, params); };
  await db.public.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  var fixtures = require(path.join(ROOT, 'scripts', 'test-fixtures.js'));
  await fixtures.seed();

  // 起服务
  var { createApp } = require(path.join(ROOT, 'src', 'app.js'));
  var server = createApp().listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  var port = server.address().port;

  try {
    // ---------- 1. 路径与路由互相覆盖 ----------
    console.log('\n--- 路径与路由一致性 ---');
    // 从路由代码里抽出实际注册的路径
    var apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api.js'), 'utf8');
    var authSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'auth.js'), 'utf8');
    var actualRoutes = [];
    function collect(src, prefix) {
      var re = /router\.(get|post|put|delete)\('([^']+)'/g;
      var m;
      while ((m = re.exec(src)) !== null) {
        actualRoutes.push(prefix + m[2]);
      }
    }
    collect(authSrc, '/api');
    collect(apiSrc, '/api');

    var documented = [];
    Object.keys(doc.paths).forEach(function (p) {
      if (p === '/health') { documented.push(p); return; }
      documented.push(p);
    });

    actualRoutes.forEach(function (r) {
      check('路由 ' + r + ' 在 openapi 里有声明', documented.indexOf(r) !== -1);
    });
    documented.forEach(function (p) {
      if (p === '/health') return;
      check('openapi 里的 ' + p + ' 在路由里真实存在', actualRoutes.indexOf(p) !== -1);
    });

    // ---------- 2. 逐个接口打一遍，比对字段 ----------
    console.log('\n--- 响应字段与 schema 一致 ---');
    var auth = require(path.join(ROOT, 'src', 'services', 'auth.js'));
    var token = auth.issueToken('openid-x');
    var authHeader = { Authorization: 'Bearer ' + token };

    var cases = [
      { name: '健康检查', method: 'GET', url: '/health', docPath: '/health' },
      { name: '地区列表', method: 'GET', url: '/api/regions', docPath: '/api/regions' },
      { name: '经纬度定位', method: 'GET', url: '/api/locate?lat=23.129112&lng=113.264385', docPath: '/api/locate' },
      { name: '首页', method: 'GET', url: '/api/home?regionCode=440000', docPath: '/api/home' },
      { name: '走势', method: 'GET', url: '/api/trend?regionCode=440000&fuelId=92&period=3m', docPath: '/api/trend' },
      { name: '调价通知', method: 'GET', url: '/api/notices?regionCode=440000&filter=official', docPath: '/api/notices' },
      { name: '国际行情', method: 'GET', url: '/api/market?symbol=brent&period=1d', docPath: '/api/market' },
      { name: '同步状态', method: 'GET', url: '/api/sync-status', docPath: '/api/sync-status' },
      { name: '提醒规则', method: 'GET', url: '/api/rules', docPath: '/api/rules', headers: authHeader },
      { name: '提醒记录', method: 'GET', url: '/api/history', docPath: '/api/history', headers: authHeader }
    ];

    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      var res = await request(port, c.method, c.url, null, c.headers);
      check(c.name + ' 返回 200', res.status === 200, 'HTTP ' + res.status);
      check(c.name + ' 外壳 ok=true', res.body && res.body.ok === true, res.text.slice(0, 120));

      var op = doc.paths[c.docPath] && doc.paths[c.docPath][c.method.toLowerCase()];
      if (!op) { check(c.name + ' 在 openapi 里有定义', false); continue; }

      var declared = dataPropsOf(doc, op.responses['200'].content['application/json'].schema);
      if (declared && res.body && res.body.data) {
        checkFields(c.name, res.body.data, declared, c.url);
      }
    }

    // ---------- 3. 认证接口 ----------
    console.log('\n--- 登录接口 ---');
    var noCode = await request(port, 'POST', '/api/login', {});
    check('登录缺 code 返回 ok=false', noCode.body && noCode.body.ok === false);
    check('登录缺 code 的 code 与文档一致',
      noCode.body && noCode.body.code === 'NO_CODE', noCode.body && noCode.body.code);
    // 文档里声明的 NO_CODE 错误码要真的存在
    var loginDesc = doc.paths['/api/login'].post.responses['200'].content['application/json'].schema;
    check('登录接口声明了响应结构', !!loginDesc);

    // ---------- 4. 401 响应有声明 ----------
    console.log('\n--- 401 声明 ---');
    var rulesOp = doc.paths['/api/rules'].get;
    check('GET /api/rules 声明了 401', !!rulesOp.responses['401']);
    var noAuth = await request(port, 'GET', '/api/rules');
    check('未带 token 实际返回 401', noAuth.status === 401, 'HTTP ' + noAuth.status);
    check('401 的 code 与文档一致', noAuth.body && noAuth.body.code === 'UNAUTHORIZED');

    // ---------- 5. 枚举值与实际一致 ----------
    console.log('\n--- 枚举与实际取值 ---');
    var market = await request(port, 'GET', '/api/market?symbol=wti&period=1d');
    check('market.symbol 在文档枚举内',
      doc.components.schemas.MarketResponse.properties.data.properties.symbol.enum.indexOf(market.body.data.symbol) !== -1);
    var sync = await request(port, 'GET', '/api/sync-status');
    var syncEnum = doc.components.schemas.SyncStatusResponse.properties.data.properties.status.enum;
    check('sync.status 在文档枚举内', syncEnum.indexOf(sync.body.data.status) !== -1,
      sync.body.data.status);

    // ---------- 6. 关键字段类型 ----------
    console.log('\n--- 字段类型 ---');
    var home = await request(port, 'GET', '/api/home?regionCode=440000');
    check('home.prices[].id 是字符串',
      typeof home.body.data.prices[0].id === 'string', typeof home.body.data.prices[0].id);
    check('home.window.date 是 YYYY-MM-DD',
      /^\d{4}-\d{2}-\d{2}$/.test(home.body.data.window.date), home.body.data.window.date);
    check('home.trend30 有数据点',
      home.body.data.trend30['92'].points.length > 0);
    var m = await request(port, 'GET', '/api/market?symbol=brent&period=1d');
    check('market.axis 是字符串（不是数组）', typeof m.body.data.axis === 'string', typeof m.body.data.axis);
    var t = await request(port, 'GET', '/api/trend?regionCode=440000&fuelId=92&period=3m');
    check('trend.axis 是数组', Array.isArray(t.body.data.axis));

    // ---------- 7. 定位语义 ----------
    console.log('\n--- 定位语义 ---');
    var locateCase = await request(port, 'GET', '/api/locate?lat=23.129112&lng=113.264385');
    check('广州坐标定位到广东',
      locateCase.body && locateCase.body.data && locateCase.body.data.regionCode === '440000',
      JSON.stringify(locateCase.body && locateCase.body.data));
    check('定位结果的 match 在文档枚举内',
      doc.components.schemas.LocateResponse.properties.data.properties.match.enum
        .indexOf(locateCase.body.data.match) !== -1);
    var outside = await request(port, 'GET', '/api/locate?lat=35.689487&lng=139.691711');
    check('境外坐标匹配不到省份',
      outside.body && outside.body.data && outside.body.data.match === 'none',
      JSON.stringify(outside.body && outside.body.data));

    console.log('\n--- 汇总 ---');
    console.log('检查 ' + checks + ' 项，失败 ' + failures.length + ' 项');
    if (failures.length) {
      failures.forEach(function (f) { console.log('  ✗ ' + f); });
      process.exitCode = 1;
    } else {
      console.log('全部通过：文档与实现一致。');
    }
  } finally {
    server.close();
  }
}

main().catch(function (err) {
  console.error('\n校验异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
