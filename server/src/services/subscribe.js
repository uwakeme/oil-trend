/**
 * 订阅消息下发
 *
 * 自建后端不走云开发，走微信官方 HTTP 接口：
 *   POST https://api.weixin.qq.com/cgi-bin/message/subscribe/send
 *
 * access_token 用 appid + secret 换，有效期 2 小时，必须缓存。
 * 多个实例各缓存一份没关系：微信对同一 appid 的 token 刷新有容忍度，
 * 拿到新 token 的实例会把旧的顶掉，其它实例继续用旧的可能收到
 * 「token 已失效」的错误 —— 所以请求失败且错误码是 40001 时，
 * 要清掉缓存重新取一次再重试。
 */
const config = require('../config');
const auth = require('./auth');
const templates = require('./subscribe-templates');

var tokenCache = null;   // { token, expiresAt }
var refreshing = null;   // 并发刷新时复用一个 Promise

/**
 * 取 access_token，带缓存
 */
function getAccessToken(force) {
  var now = Date.now();
  if (!force && tokenCache && tokenCache.expiresAt > now) {
    return Promise.resolve(tokenCache.token);
  }
  // 已经有刷新在跑就等它，别并发打接口
  if (refreshing) return refreshing;

  refreshing = auth.callWeChat('/cgi-bin/token', {
    grant_type: 'client_credential',
    appid: config.appId,
    secret: config.appSecret
  }).then(function (res) {
    refreshing = null;
    if (res.errcode) {
      var err = new Error(res.errmsg || '获取 access_token 失败');
      err.code = 'WECHAT_' + res.errcode;
      throw err;
    }
    if (!res.access_token) {
      var e = new Error('微信未返回 access_token');
      e.code = 'NO_ACCESS_TOKEN';
      throw e;
    }
    // 提前 5 分钟过期，避免边界上用到失效 token
    var ttl = (res.expires_in || 7200) - 300;
    tokenCache = { token: res.access_token, expiresAt: Date.now() + ttl * 1000 };
    return res.access_token;
  }).catch(function (err) {
    refreshing = null;
    throw err;
  });

  return refreshing;
}

/**
 * 下发一条订阅消息
 * @param {object} options { openid, templateId, page, data, miniprogramState }
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
function send(options) {
  var tplId = options.templateId || templateId();
  if (!tplId) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_NOT_CONFIGURED' });
  }
  if (!options.openid) {
    return Promise.resolve({ sent: false, reason: 'NO_OPENID' });
  }

  var body = {
    touser: options.openid,
    template_id: tplId,
    page: options.page || 'pages/index/index',
    data: options.data || {},
    // 开发版 / 体验版联调时要配 OIL_MINIPROGRAM_STATE=developer，
    // 否则用户点开订阅消息跳不到对应版本
    miniprogram_state: options.miniprogramState || config.miniprogramState || 'formal',
    lang: 'zh_CN'
  };

  function post(token) {
    return auth.callWeChat('/cgi-bin/message/subscribe/send', { access_token: token }, body);
  }

  return getAccessToken(false).then(function (token) {
    return post(token);
  }).then(function (res) {
    // 40001 = access_token 无效，清缓存重取一次再发
    if (res.errcode === 40001 || res.errcode === 40014) {
      return getAccessToken(true).then(function (token) {
        return post(token);
      });
    }
    return res;
  }).then(function (res) {
    if (res.errcode) {
      console.error('[subscribe] 下发失败', res.errcode, res.errmsg);
      return { sent: false, reason: (res.errcode + ':' + (res.errmsg || 'unknown')) };
    }
    return { sent: true };
  }).catch(function (err) {
    console.error('[subscribe] 请求异常', err.message);
    return { sent: false, reason: err.message || String(err) };
  });
}

module.exports = {
  send: send,
  getAccessToken: getAccessToken,
  /**
   * 当前使用的模板 ID。
   *
   * 优先用 .env 的 OIL_SUBSCRIBE_TEMPLATE_ID（部署时可以覆盖），
   * 没配就用契约表里的主模板 —— 契约表是平台模板的镜像，
   * 平台换了模板必须同步改 subscribe-templates.js，
   * 否则字段对不上，消息会被平台拒收。
   */
  templateId: function () { return config.subscribeTemplateId || templates.PRIMARY_TEMPLATE_ID; }
};
