/**
 * 后端适配层
 *
 * 小程序只认这一个文件 —— utils/api.js 通过它取数，
 * 页面完全不知道后端是云开发还是自建服务器。
 *
 * 后端只有自建服务器（server/）：填了 config.apiBaseUrl 就走 wx.request，
 * 没填就当作「没有后端」，所有取数回落到本地演示数据。
 *（微信云开发那套已下线，云函数目录也删了 —— 见 git 历史）
 *
 * ⚠️ 上层仍按「函数名 + action」调用，REST 按路径调用，
 * 这里做一次映射。映射表改起来只有一个地方。
 */
const config = require('../config/index');

/** 后端类型：'server' | 'none' */
var backend = 'none';
var initError = null;

/** 登录态：自建后端要靠它 */
var authToken = '';
var loginPromise = null;

/**
 * 云函数 action → REST 路径
 * query 类用 GET，user 类用 POST（要带 body）
 */
var ACTION_MAP = {
  'regions': { method: 'GET', path: '/api/regions' },
  'home': { method: 'GET', path: '/api/home' },
  'trend': { method: 'GET', path: '/api/trend' },
  'notices': { method: 'GET', path: '/api/notices' },
  'market': { method: 'GET', path: '/api/market' },
  'rules.list': { method: 'GET', path: '/api/rules' },
  'rules.save': { method: 'POST', path: '/api/rules', bodyKey: 'rules' },
  'history.list': { method: 'GET', path: '/api/history' },
  'history.save': { method: 'POST', path: '/api/history', bodyKey: 'history' }
};

/* ---------------- 初始化 ---------------- */

/**
 * 决定用哪个后端。
 * 有 apiBaseUrl 就走自建服务器，否则走云开发。
 */
function initCloud(app) {
  if (config.apiBaseUrl) {
    backend = 'server';
    initError = null;
    // 自建后端要先登录换 token，失败不影响后续取数（api.js 会回落演示源）
    ensureLogin();
    return true;
  }
  // 没配后端地址就当「没有后端」：取数一律回落本地演示数据
  backend = 'none';
  initError = 'NO_API_BASE_URL';
  return false;
}

function isReady() {
  return backend !== 'none';
}

function lastError() {
  return initError;
}

/**
 * 等登录完成。
 *
 * 页面取数可能早于 wx.login 的回调，用户类接口（规则、记录）
 * 必须等 token 到位，否则服务端一律 401。
 */
function loginReady() {
  if (backend !== 'server') return Promise.resolve(null);
  return ensureLogin();
}

/** 当前用的是哪个后端，页面要如实展示数据来源 */
function backendName() {
  if (backend === 'server') return '自建服务器';
  return '未配置';
}

/* ---------------- 登录（自建后端） ---------------- */

/**
 * wx.login() 换 code → 服务端换 token。
 * 失败不抛：取数时如果没 token，服务端会返回 401，api.js 照样回落演示源。
 *
 * 注意这是异步的：onLaunch 里发起登录时，页面可能已经在取数了。
 * 所以用户类接口要等登录完成 —— 下面的 loginReady 就是干这个的。
 */
function ensureLogin() {
  if (backend !== 'server') return Promise.resolve(null);
  if (authToken) return Promise.resolve(authToken);
  if (loginPromise) return loginPromise;
  if (typeof wx.login !== 'function') return Promise.resolve(null);

  loginPromise = new Promise(function (resolve) {
    wx.login({
      success: function (res) {
        if (!res || !res.code) {
          resolve(null);
          return;
        }
        requestRaw('POST', '/api/login', { code: res.code }, false)
          .then(function (data) {
            authToken = (data && data.token) || '';
            resolve(authToken || null);
          })
          .catch(function () {
            resolve(null);
          });
      },
      fail: function () {
        resolve(null);
      }
    });
  });

  return loginPromise;
}

/* ---------------- HTTP 请求 ---------------- */

var HTTP_TIMEOUT = 12000;

function requestRaw(method, path, data, withAuth) {
  return new Promise(function (resolve, reject) {
    var url = config.apiBaseUrl.replace(/\/$/, '') + path;
    var header = { 'Content-Type': 'application/json' };
    if (withAuth && authToken) {
      header.Authorization = 'Bearer ' + authToken;
    }

    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('请求超时（' + (HTTP_TIMEOUT / 1000) + 's）'));
    }, HTTP_TIMEOUT);

    var task = wx.request({
      url: url,
      method: method,
      data: data || {},
      header: header,
      timeout: HTTP_TIMEOUT,
      success: function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var body = res.data;
        // 服务端统一返回 { ok, data } / { ok: false, message, code }
        if (body && body.ok === false) {
          var err = new Error(body.message || 'SERVER_ERROR');
          err.code = body.code || 'SERVER_ERROR';
          reject(err);
          return;
        }
        if (body && body.ok === true) {
          resolve(body.data);
          return;
        }
        reject(new Error('服务器返回格式不对'));
      },
      fail: function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error((err && err.errMsg) || '网络请求失败'));
      }
    });
    if (task && typeof task.abort === 'function') {
      // 页面切走时中止未完成的请求，省流量
      // （不 abort 也不影响正确性，只是留着没意义）
    }
  });
}

/* ---------------- 对外统一入口 ---------------- */

/**
 * 调用后端。
 *
 * 保持和原来 wx.cloud.callFunction 一样的签名与语义：
 *   callFunction('oilApi', { action: 'home', regionCode: '440000' })
 *     → Promise<业务数据>
 *
 * @param {string} name 云函数名。自建后端下忽略（路由由 action 决定），
 *                     但保留是为了让 api.js 一行不用改。
 * @param {object} data 业务参数，必须含 action
 * @returns {Promise<any>} resolve 业务数据，reject 失败
 */
function callFunction(name, data) {
  var payload = data || {};

  if (backend === 'server') {
    var mapped = ACTION_MAP[payload.action];
    if (!mapped) {
      return Promise.reject(new Error('未知 action: ' + payload.action));
    }

    // GET 的参数放 query，POST 的放 body
    var queryData = {};
    var bodyData = {};
    Object.keys(payload).forEach(function (k) {
      if (k === 'action') return;
      if (mapped.method === 'GET') {
        queryData[k] = payload[k];
      } else if (mapped.bodyKey === k) {
        bodyData[k] = payload[k];
      }
    });

    var needAuth = mapped.method === 'POST' || mapped.path === '/api/rules' || mapped.path === '/api/history';

    // 需要登录的接口先确保有 token（loginReady 会等 wx.login 的回调）
    return (needAuth ? loginReady() : Promise.resolve())
      .then(function () {
        return requestRaw(mapped.method, mapped.path, mapped.method === 'GET' ? queryData : bodyData, needAuth);
      })
      .catch(function (err) {
        // token 过期（401）时重新登录再试一次
        if (err && err.code === 'UNAUTHORIZED') {
          authToken = '';
          loginPromise = null;
          return ensureLogin().then(function () {
            return requestRaw(mapped.method, mapped.path, mapped.method === 'GET' ? queryData : bodyData, true);
          });
        }
        throw err;
      });
  }

  return Promise.reject(new Error(initError || 'NO_BACKEND'));
}

module.exports = {
  initCloud: initCloud,
  isReady: isReady,
  lastError: lastError,
  callFunction: callFunction,
  backendName: backendName,
  ensureLogin: ensureLogin,
  loginReady: loginReady
};
