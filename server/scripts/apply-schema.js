/**
 * 应用数据库结构
 *
 * 用项目自带的 pg 执行 schema.sql，不依赖服务器装 psql。
 * schema.sql 里全是 CREATE TABLE IF NOT EXISTS，重复执行安全。
 *
 * 用法：node scripts/apply-schema.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');

// 从 .env 读 DATABASE_URL（config.js 也读，但这里要的是连接串本身）
function readEnv() {
  var envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  var out = {};
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
  return out;
}

var env = readEnv();
var url = process.env.DATABASE_URL || env.DATABASE_URL;

if (!url) {
  console.error('缺少 DATABASE_URL（环境变量或 server/.env 里都要有）');
  process.exit(1);
}

var schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');

var client = new Client({ connectionString: url });
client.connect()
  .then(function () {
    return client.query(schema);
  })
  .then(function () {
    console.log('[schema] 数据库结构已应用');
  })
  .catch(function (err) {
    console.error('[schema] 应用失败：', err.message);
    process.exitCode = 1;
  })
  .then(function () {
    return client.end();
  })
  .catch(function (err) {
    console.error('[schema] 连接失败：', err.message);
    process.exit(1);
  });
