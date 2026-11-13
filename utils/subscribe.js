/**
 * 微信订阅消息
 *
 * 能力边界（必须在界面上如实说明）：
 *   1. 订阅消息必须由用户主动点击触发，一次授权只对应一次下发；
 *   2. 未授权时无法在后台推送任何消息；
 *   3. 模板 ID 与正式 appid 绑定，测试号无法真实下发。
 *
 * 所以这里把「能不能发」和「用户以为的能不能发」都如实反馈给页面。
 */
const config = require('../config/index');

function hasTemplate() {
  return Array.isArray(config.subscribeTemplateIds) && config.subscribeTemplateIds.length > 0;
}

function isSupported() {
  return typeof wx.requestSubscribeMessage === 'function';
}

/**
 * 发起订阅授权
 * @returns {Promise<{granted: string[], denied: string[], reason?: string}>}
 */
function requestSubscribe() {
  return new Promise(function (resolve) {
    if (!hasTemplate()) {
      resolve({
        granted: [],
        denied: [],
        reason: 'NO_TEMPLATE',
        message: '尚未配置订阅消息模板 ID，无法发起授权。'
      });
      return;
    }
    if (!isSupported()) {
      resolve({
        granted: [],
        denied: [],
        reason: 'UNSUPPORTED',
        message: '当前环境不支持订阅消息。'
      });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: config.subscribeTemplateIds,
      success: function (res) {
        var granted = [];
        var denied = [];
        Object.keys(res || {}).forEach(function (key) {
          // ⚠️ res 里还有 errMsg 字段（值是 "requestSubscribeMessage:ok"），
          // 它不是模板 ID —— 当成「被拒的模板」塞进 denied 是错的。
          if (key === 'errMsg') return;
          var state = res[key];
          if (state === 'accept') granted.push(key);
          else if (state === 'reject' || state === 'ban') denied.push(key);
        });
        resolve({ granted: granted, denied: denied });
      },
      fail: function (err) {
        resolve({
          granted: [],
          denied: [],
          reason: (err && err.errMsg) || 'REQUEST_FAILED',
          message: '订阅授权未完成，可在「提醒」页重新开启。'
        });
      }
    });
  });
}

module.exports = {
  hasTemplate: hasTemplate,
  isSupported: isSupported,
  requestSubscribe: requestSubscribe
};
