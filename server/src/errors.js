/**
 * 对外错误信息
 *
 * ⚠️ 以前三处（app.js 的兜底、routes/api.js 的 handle、routes/auth.js 的 login）
 * 都把 err.message 原样返回客户端 —— 会带出 pg 的 SQL 错误、微信的 errmsg、
 * 拼接的响应体片段等内部信息。
 *
 * 这里定一张白名单：只有自己定义的、业务上需要用户知道的错误码才透出原文，
 * 其余一律换成固定文案，详情只写日志。
 *
 * ⚠️ 白名单里的 code 是**对外契约**，小程序端靠它判断要不要重登
 * （utils/cloud.js: err.code === 'UNAUTHORIZED'），改名字要同步改前端。
 */
var PUBLIC_ERRORS = {
  UNAUTHORIZED: '登录已失效，请重新进入小程序',
  FORBIDDEN: '没有权限访问该资源',
  NOT_FOUND: '接口不存在',
  NO_CODE: '缺少登录凭证',
  LOGIN_FAILED: '登录失败，请稍后重试',
  INVALID_REGION: '地区代码不存在',
  INVALID_RULES: '提醒规则格式不正确',
  INVALID_HISTORY: '提醒记录格式不正确',
  INVALID_FUEL: '油品标号不存在',
  INVALID_TARGET_PRICE: '目标价不合法',
  TOO_MANY_RULES: '一次最多提交 50 条规则',
  TOO_MANY_HISTORY: '一次最多提交 50 条记录',
  NO_HISTORY: '该区间暂无历史数据',
  RATE_LIMITED: '请求太频繁，请稍后再试',
  TEMPLATE_NOT_CONFIGURED: '尚未配置订阅消息模板',
  TEMPLATE_NOT_REGISTERED: '订阅消息模板未登记',
  INVALID_INPUT: '请求参数不正确'
};

/** 默认文案：内部错误一律用它，细节只进日志 */
var GENERIC_MESSAGE = '服务器内部错误，请稍后重试';

/**
 * 对外错误码 → HTTP 状态码。
 *
 * ⚠️ 以前一律 200 + { ok:false }：外壳统一是好事，
 * 但 nginx / 云监控 / CI 只能靠状态码识别故障，
 * 全 200 等于可观测性归零 —— 数据库挂了也看不出来。
 * 现在业务错误 4xx、内部错误 5xx，外壳 { ok, message, code } 不变。
 */
var STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NO_CODE: 400,
  LOGIN_FAILED: 401,
  INVALID_REGION: 400,
  INVALID_RULES: 400,
  INVALID_HISTORY: 400,
  INVALID_FUEL: 400,
  INVALID_TARGET_PRICE: 400,
  TOO_MANY_RULES: 400,
  TOO_MANY_HISTORY: 400,
  NO_HISTORY: 404,
  RATE_LIMITED: 429,
  TEMPLATE_NOT_CONFIGURED: 500,
  TEMPLATE_NOT_REGISTERED: 500,
  INVALID_INPUT: 400
};

/**
 * 取一个异常该返回的 HTTP 状态码。
 * 不在白名单里的一律 500 —— 内部错误不该让客户端以为是自己的问题。
 */
function statusOf(err) {
  var code = (err && err.code) || 'INTERNAL_ERROR';
  return STATUS_BY_CODE[code] || 500;
}

/**
 * 把异常转成对外可返回的错误体。
 * @param {Error} err
 * @returns {{ok:false, message:string, code:string}}
 */
function publicError(err) {
  var code = (err && err.code) || 'INTERNAL_ERROR';
  var message = PUBLIC_ERRORS[code];
  if (!message) {
    // 不在白名单里：对外只给通用文案
    return { ok: false, message: GENERIC_MESSAGE, code: 'INTERNAL_ERROR' };
  }
  return { ok: false, message: message, code: code };
}

module.exports = {
  PUBLIC_ERRORS: PUBLIC_ERRORS,
  GENERIC_MESSAGE: GENERIC_MESSAGE,
  publicError: publicError,
  statusOf: statusOf,
  STATUS_BY_CODE: STATUS_BY_CODE
};