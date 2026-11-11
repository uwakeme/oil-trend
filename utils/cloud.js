/**
 * 微信云开发封装
 *
 * 未开通云开发 / 使用测试号时，wx.cloud 会不可用，
 * 此时所有调用会 reject，由 api.js 回落到本地演示数据源。
 */
const config = require('../config/index');

var cloudReady = false;
var initError = null;

function initCloud(app) {
  if (typeof wx.cloud === 'undefined' || typeof wx.cloud.init !== 'function') {
    initError = 'WX_CLOUD_UNAVAILABLE';
    cloudReady = false;
    return false;
  }
  try {
    var options = { traceUser: true };
    if (config.cloudEnvId) options.env = config.cloudEnvId;
    wx.cloud.init(options);
    cloudReady = true;
    initError = null;
  } catch (err) {
    cloudReady = false;
    initError = (err && err.errMsg) || String(err);
  }
  return cloudReady;
}

function isReady() {
  return cloudReady;
}

function lastError() {
  return initError;
}

/**
 * 调用云函数
 * @param {string} name 云函数名
 * @param {object} data 入参
 * @returns {Promise<any>} resolve 云函数返回的 data 字段
 */
// 云函数调用的超时上限。wx.cloud.callFunction 自己没有超时，
// 网络挂住时 loading 会永远转下去。
var CALL_TIMEOUT = 12000;

function callFunction(name, data) {
  return new Promise(function (resolve, reject) {
    if (!cloudReady) {
      reject(new Error(initError || 'CLOUD_NOT_READY'));
      return;
    }
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('云函数调用超时（' + (CALL_TIMEOUT / 1000) + 's）'));
    }, CALL_TIMEOUT);

    wx.cloud.callFunction({
      name: name,
      data: data || {}
    }).then(function (res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var result = res && res.result;
      if (result && result.ok === false) {
        var err = new Error(result.message || 'CLOUD_FUNCTION_ERROR');
        err.code = result.code || 'CLOUD_FUNCTION_ERROR';
        reject(err);
        return;
      }
      resolve(result && result.data !== undefined ? result.data : result);
    }).catch(function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = {
  initCloud: initCloud,
  isReady: isReady,
  lastError: lastError,
  callFunction: callFunction
};
