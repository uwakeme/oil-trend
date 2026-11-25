/**
 * 登录与身份
 *
 * 云开发里 cloud.getWXContext() 直接给 openid；自建没有这能力，
 * 要自己走一遍：
 *
 *   小程序 wx.login() → code（5 分钟有效、一次性）
 *     → POST /api/login { code }
 *     → 服务端 code2session(code + appid + secret) → openid
 *     → 签发自己的 token，后续请求带 Authorization
 *
 * token 用 HMAC 签名，不引额外依赖也不需要 session 存储：
 *   base64url(payload).base64url(hmac-sha256(payload, secret))
 * payload 里放 openid 与过期时间戳。
 */
const crypto = require('crypto');
const https = require('https');
const config = require('../config');

var TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 天
var WECHAT_IDLE_TIMEOUT_MS = 10000;
var WECHAT_TOTAL_TIMEOUT_MS = 15000;
var WECHAT_MAX_RESPONSE_BYTES = 1024 * 1024;

/* ---------------- 微信 HTTP 调用 ---------------- */

/**
 * 调微信开放接口
 * @param {string} urlPath 以 / 开头，如 /sns/jscode2session
 * @param {object} query 查询参数
 * @param {object} post POST 体（没有就不传）
 */
function callWeChat(urlPath, query, post) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var totalTimer = null;
    var req = null;
    function settle(fn, value) {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      fn(value);
    }
    function fail(message) {
      if (settled) return;
      if (req) req.destroy();
      settle(reject, new Error(message));
    }

    var qs = Object.keys(query || {})
      .filter(function (k) { return query[k] !== undefined && query[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); })
      .join('&');
    var body = post ? JSON.stringify(post) : null;
    var headers = { Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    try {
      req = https.request({
        hostname: 'api.weixin.qq.com',
        path: urlPath + (qs ? '?' + qs : ''),
        method: body ? 'POST' : 'GET',
        headers: headers,
        timeout: WECHAT_IDLE_TIMEOUT_MS
      }, function (res) {
        if (settled) {
          res.resume();
          return;
        }
        var chunks = [];
        var size = 0;
        res.on('data', function (c) {
          if (settled) return;
          size += c.length;
          if (size > WECHAT_MAX_RESPONSE_BYTES) {
            fail('微信接口响应体超过 1MB 限制');
            return;
          }
          chunks.push(c);
        });
        res.on('error', function (err) { settle(reject, err); });
        res.on('end', function () {
          if (settled) return;
          var text = Buffer.concat(chunks).toString('utf8');
          try {
            settle(resolve, JSON.parse(text));
          } catch (e) {
            settle(reject, new Error('微信接口返回的不是 JSON：' + text.slice(0, 200)));
          }
        });
      });
    } catch (e) {
      settle(reject, e);
      return;
    }
    req.setTimeout(WECHAT_IDLE_TIMEOUT_MS, function () {
      fail('微信接口请求超时');
    });
    req.on('error', function (err) { settle(reject, err); });
    // 空闲超时会被持续收到的数据重置，总时限必须独立计时。
    totalTimer = setTimeout(function () {
      fail('微信接口请求总时限已到');
    }, WECHAT_TOTAL_TIMEOUT_MS);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * code 换 openid
 * @param {string} code wx.login() 拿到的临时凭证
 */
function code2Session(code) {
  return callWeChat('/sns/jscode2session', {
    appid: config.appId,
    secret: config.appSecret,
    js_code: code,
    grant_type: 'authorization_code'
  }).then(function (res) {
    if (res.errcode) {
      var err = new Error(res.errmsg || 'code2Session 失败');
      err.code = 'WECHAT_' + res.errcode;
      throw err;
    }
    if (!res.openid) {
      var e = new Error('code2Session 未返回 openid');
      e.code = 'NO_OPENID';
      throw e;
    }
    return { openid: res.openid, sessionKey: res.session_key || '' };
  });
}

/* ---------------- token 签发与校验 ---------------- */

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return base64url(crypto.createHmac('sha256', config.tokenSecret).update(payload).digest());
}

/**
 * 签发 token
 * @param {string} openid
 */
function issueToken(openid) {
  var payload = base64url(JSON.stringify({
    openid: openid,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  }));
  return payload + '.' + sign(payload);
}

/**
 * 校验 token
 * @returns {object|null} { openid, exp } 或 null
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var payload = parts[0];
  var expected = sign(payload);
  // 定长比较，避免时序侧信道
  var a = Buffer.from(expected);
  var b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    var data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (!data.openid || !data.exp) return null;
    if (Date.now() / 1000 > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

/**
 * 换取登录态
 * @param {string} code
 * @returns {Promise<{token:string, openid:string}>}
 */
function login(code) {
  if (!code || typeof code !== 'string') {
    var e = new Error('缺少 code');
    e.code = 'NO_CODE';
    return Promise.reject(e);
  }
  // ⚠️ 微信凭据没配 = 这项能力不可用，不是「内部错误」。
  // 以前这里直接去打 code2session，失败后落到 500 ——
  // 客户端只会看到「服务器内部错误」，看不出是服务没配微信凭据。
  // 单独给一个错误码，对外返回 503（能力不可用），日志里写清原因。
  if (!config.appId || !config.appSecret) {
    var e2 = new Error('未配置 WX_APP_ID / WX_APP_SECRET');
    e2.code = 'WX_NOT_CONFIGURED';
    return Promise.reject(e2);
  }
  return code2Session(code).then(function (s) {
    return { token: issueToken(s.openid), openid: s.openid };
  });
}

module.exports = {
  login: login,
  issueToken: issueToken,
  verifyToken: verifyToken,
  code2Session: code2Session,
  callWeChat: callWeChat,
  TOKEN_TTL_SECONDS: TOKEN_TTL_SECONDS
};
