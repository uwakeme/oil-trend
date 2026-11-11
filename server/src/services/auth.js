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

/* ---------------- 微信 HTTP 调用 ---------------- */

/**
 * 调微信开放接口
 * @param {string} urlPath 以 / 开头，如 /sns/jscode2session
 * @param {object} query 查询参数
 * @param {object} post POST 体（没有就不传）
 */
function callWeChat(urlPath, query, post) {
  return new Promise(function (resolve, reject) {
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
    var req = https.request({
      hostname: 'api.weixin.qq.com',
      path: urlPath + (qs ? '?' + qs : ''),
      method: body ? 'POST' : 'GET',
      headers: headers,
      timeout: 10000
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('微信接口返回的不是 JSON：' + text.slice(0, 200)));
        }
      });
    });
    req.setTimeout(10000, function () {
      req.destroy();
      reject(new Error('微信接口请求超时'));
    });
    req.on('error', reject);
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
