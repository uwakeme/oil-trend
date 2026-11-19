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

/* ---------------- 配置值（先算出来，validate() 要用） ---------------- */

var port = Number(optional('PORT', 3000));
var appId = optional('WX_APP_ID', '');
var appSecret = optional('WX_APP_SECRET', '');
var subscribeTemplateId = optional('OIL_SUBSCRIBE_TEMPLATE_ID', '');
// 「方向提醒」模板：调整幅度是**文本类型**的模板。
// ⚠️ 官方公告只给吨价时，每升幅度可能拿不到 ——
// 主模板的「调整价格」是 amount 类型，只能填「数字+元」，
// 幅度未知时填 0 等于冒充「持平」，留空平台直接拒收；
// 只有文本类型的模板能把「幅度待公布」这种话原样发出去。
var subscribeDirectionTemplateId = optional('OIL_SUBSCRIBE_DIRECTION_TEMPLATE_ID', '');
var miniprogramState = optional('OIL_MINIPROGRAM_STATE', 'formal');
var tokenSecret = optional('OIL_TOKEN_SECRET', '');
var apiBaseUrl = optional('OIL_API_BASE_URL', '');
var databaseUrl = optional('DATABASE_URL', '');
var collectCron = optional('OIL_COLLECT_CRON', '0 */30 * * * *');
var alertCron = optional('OIL_ALERT_CRON', '0 */10 * * * *');

/**
 * 启动前的配置体检。
 *
 * ⚠️ 以前 start() 不校验任何配置：空串作 HMAC key 不报错，
 * issueToken 照常签发 —— 签名算法是开源的，攻击者拿空密钥就能自签
 * 任意 openid 的 token，然后以别人的身份读写提醒规则与记录。
 * /health 又只查「进程活着」，带空密钥的服务照常返回 200，
 * 部署流水线看不出任何异常。
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
function validate() {
  var errors = [];
  var warnings = [];

  if (!tokenSecret) {
    errors.push('缺少环境变量 OIL_TOKEN_SECRET（自签 token 的密钥），见 server/.env.example');
  } else if (tokenSecret.length < 32) {
    errors.push('OIL_TOKEN_SECRET 太短（至少 32 位），当前 ' + tokenSecret.length + ' 位');
  }
  if (!databaseUrl) {
    errors.push('缺少环境变量 DATABASE_URL，见 server/.env.example');
  }
  // 微信凭据只影响登录与订阅消息，缺了不至于让服务起不来 —— 用警告而不是致命错误
  if (!appId) warnings.push('未配置 WX_APP_ID：登录与订阅消息不可用');
  if (!appSecret) warnings.push('未配置 WX_APP_SECRET：登录与订阅消息不可用');
  // 订阅消息模板 ID：.env 里配的必须在契约表里登记过。
  // ⚠️ 模板 ID 手抄错一个字符（小写 l / 大写 I 长得一样）平台就拒收，
  // 而且日志里只写「参数无效」，看不出是 ID 错了 —— 部署前先喊一声。
  if (subscribeTemplateId) {
    var templates = require('./services/subscribe-templates');
    if (!templates.templateOf(subscribeTemplateId)) {
      warnings.push('OIL_SUBSCRIBE_TEMPLATE_ID (' + subscribeTemplateId + ') 不在契约表里，将回退到契约表默认模板 ' + templates.PRIMARY_TEMPLATE_ID);
    }
  }
  // 方向模板：配了但契约表里没登记 → 提醒发不出去（字段对不上），
  // 提前喊一声，别等到线上才发现「官方降价提醒一条都没发」。
  if (subscribeDirectionTemplateId) {
    var tpl2 = require('./services/subscribe-templates');
    if (!tpl2.templateOf(subscribeDirectionTemplateId)) {
      warnings.push('OIL_SUBSCRIBE_DIRECTION_TEMPLATE_ID (' + subscribeDirectionTemplateId + ') 不在契约表里，方向提醒不会发送（每升幅度缺失时仍不发提醒）');
    }
  }

  return { errors: errors, warnings: warnings };
}

module.exports = {
  validate: validate,
  port: port,

  // 微信小程序凭据
  // ⚠️ AppSecret 只在服务端，绝不能进小程序包或代码库
  appId: appId,
  appSecret: appSecret,

  // 订阅消息模板 ID（公众平台申请）
  // ⚠️ 与 server/src/services/subscribe-templates.js 的契约表要同步：
  //   .env 里配的模板 ID 必须登记在契约表里，否则字段对不上，消息发不出去。
  subscribeTemplateId: subscribeTemplateId,

  // 方向提醒模板 ID（调整幅度是文本类型的那个模板）
  // ⚠️ 必须在契约表 subscribe-templates.js 里登记过，否则方向提醒不发。
  subscribeDirectionTemplateId: subscribeDirectionTemplateId,

  // 小程序版本状态：formal 正式版 / developer 开发版 / trial 体验版。
  // 订阅消息下发时会写进 miniprogram_state：
  //   给开发版发消息必须配 developer，否则用户点开跳不到开发版；
  //   正式发布留空（默认 formal）。
  miniprogramState: miniprogramState,

  // 自签 token 的密钥，只在服务端
  tokenSecret: tokenSecret,

  // 后端对外地址（部署流水线用它做健康检查）
  apiBaseUrl: apiBaseUrl,

  // 数据库（读取时才校验，见 db.js）
  databaseUrl: databaseUrl,

  // 定时任务
  collectCron: collectCron,
  alertCron: alertCron,

  // 目标价提醒的取值区间（元/升）
  // ⚠️ 与小程序端 config/index.js 的 targetPriceMin/Max 必须一致：
  // 服务端拒绝的范围前端还允许填，用户会看到「保存失败」却不知道为什么。
  targetPriceMin: 1,
  targetPriceMax: 30

};
