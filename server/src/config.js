/**
 * 服务端配置
 *
 * 所有敏感信息只从环境变量读，不进代码、不进版本库。
 * .env.example 是样例，真实 .env 不入库（见 .gitignore）。
 */
const fs = require('fs');
const path = require('path');

// 极简 .env 读取：只认 KEY=VALUE，不引 dotenv 依赖
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    var key = m[1];
    var value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  });
}

/**
 * 读取必需的环境变量。
 *
 * ⚠️ 故意不在模块加载期就抛错 —— 加载期抛错会让 scripts/check-modules.js
 * 这类「只要能 require 进来」的检查全部失败，而配置文件被加载并不代表
 * 真的要连数据库。真正要用的时候再校验，见 db.js。
 */
function need(key) {
  var v = process.env[key];
  if (!v) {
    throw new Error('缺少环境变量 ' + key + '，见 server/.env.example');
  }
  return v;
}

function optional(key, fallback) {
  var v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

module.exports = {
  port: Number(optional('PORT', 3000)),

  // 微信小程序凭据
  // ⚠️ AppSecret 只在服务端，绝不能进小程序包或代码库
  appId: optional('WX_APP_ID', ''),
  appSecret: optional('WX_APP_SECRET', ''),

  // 订阅消息模板 ID（公众平台申请）
  subscribeTemplateId: optional('OIL_SUBSCRIBE_TEMPLATE_ID', ''),

  // 自签 token 的密钥，只在服务端
  tokenSecret: optional('OIL_TOKEN_SECRET', ''),

  // 后端对外地址（部署流水线用它做健康检查）
  apiBaseUrl: optional('OIL_API_BASE_URL', ''),

  // 数据库（读取时才校验，见 db.js）
  databaseUrl: optional('DATABASE_URL', ''),

  // 定时任务
  collectCron: optional('OIL_COLLECT_CRON', '0 */30 * * * *'),
  alertCron: optional('OIL_ALERT_CRON', '0 */10 * * * *'),

  // 采集开关（见 src/services/sources.js）：默认关
  collectorEnabled: optional('OIL_COLLECTOR_ENABLED', 'false') === 'true'
};
