/**
 * 数据服务层（唯一对外取数入口）
 *
 * 设计原则：**页面只认数据结构，不认数据来源**。
 *   1. config.dataSource === 'auto' 时优先走云函数；
 *   2. 云端不可用 / 调用失败 / 返回为空 → 自动回落本地演示数据源；
 *   3. 每次取数都会回报 dataFrom，页面据此如实展示数据来源。
 *
 * 接入真实接口的两种做法（都不需要改页面）：
 *   A. 在云函数 oilApi 里实现 action，再由本文件的 mapAction 路由过去；
 *   B. 直接替换本文件里的 localFn 为真实 HTTP 请求。
 */
const config = require('../config/index');
const cloud = require('./cloud');
const demo = require('../data/demo');
const store = require('./store');

function preferCloud() {
  return config.dataSource !== 'demo';
}

/**
 * 给返回值打上来源标记。
 * 「wx.cloud.init 成功」不等于「这次数据来自云端」——
 * 云函数失败回落到演示数据时，必须如实标成演示源。
 */
/**
 * 给返回值打上来源标记。
 *
 * 「wx.cloud.init 成功」不等于「这次数据来自云端」——
 * 云端失败回落到演示数据时，必须如实标成演示源。
 *
 * mode 说明：
 *   'demo'  本地演示数据
 *   'live'  真实后端返回（自建服务器或云开发，transport 里区分）
 *
 * 页面只判断 mode === 'demo' 来决定要不要标「（演示数据）」，
 * 所以从 'cloud' 改成 'live' 不影响任何页面逻辑。
 */
function stampSource(data, mode, transport) {
  if (data && typeof data === 'object') {
    data.source = Object.assign({}, data.source || {}, { mode: mode, transport: transport });
  }
  return data;
}

/**
 * 云端返回必须带上业务字段才算成功。
 * 只判断「是不是 object」的话，云端返回 {} 会让页面拿到空数据却显示正常。
 */
function hasExpected(data, keys) {
  if (!keys || !keys.length) return true;
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]] === undefined || data[keys[i]] === null) return false;
  }
  return true;
}

/**
 * 云端优先、本地兜底
 * @param {string}   name        云函数名
 * @param {object}   payload     云函数入参
 * @param {Function} localFn     本地兜底实现
 * @param {Array}    expectKeys  云端返回必须包含的业务字段
 */
function fetchWithFallback(name, payload, localFn, expectKeys) {
  if (preferCloud()) {
    return cloud.callFunction(name, payload).then(function (data) {
      if (data && typeof data === 'object' && hasExpected(data, expectKeys)) {
        return stampSource(data, 'live', cloud.backendName());
      }
      return stampSource(localFn(), 'demo', '本地演示源（后端返回数据不完整）');
    }).catch(function (err) {
      return stampSource(localFn(), 'demo',
        '本地演示源（后端调用失败：' + (err && err.message ? err.message : '未知原因') + '）');
    });
  }
  return Promise.resolve(stampSource(localFn(), 'demo', '本地演示源（未配置后端）'));
}

/** 地区列表 */
function getRegions() {
  return fetchWithFallback('oilApi', { action: 'regions' }, function () {
    return { regions: demo.getRegions() };
  }).then(function (res) {
    return res.regions || demo.getRegions();
  });
}

/** 首页数据 */
function getHome(regionCode, fuelId) {
  return fetchWithFallback('oilApi', { action: 'home', regionCode: regionCode, fuelId: fuelId }, function () {
    return demo.getHome(regionCode, fuelId);
  }, ['prices', 'window']);
}

/** 走势数据 */
function getTrend(regionCode, fuelId, period) {
  return fetchWithFallback('oilApi', {
    action: 'trend',
    regionCode: regionCode,
    fuelId: fuelId,
    period: period
  }, function () {
    return demo.getTrend(regionCode, fuelId, period);
  }, ['points']);
}

/** 调价通知数据 */
function getNotices(regionCode, filter, fuelId) {
  return fetchWithFallback('oilApi', {
    action: 'notices',
    regionCode: regionCode,
    filter: filter,
    fuelId: fuelId
  }, function () {
    return demo.getNotices(regionCode, filter, fuelId);
  }, ['notices']);
}

/** 国际行情 */
function getMarket(symbol, period) {
  return fetchWithFallback('oilApi', { action: 'market', symbol: symbol, period: period }, function () {
    return demo.getMarket(symbol, period);
  }, ['price', 'points']);
}

/* ---------- 提醒规则与记录 ---------- */

function getAlertRules() {
  if (preferCloud()) {
    return cloud.callFunction('oilApi', { action: 'rules.list' }).then(function (data) {
      if (data && Array.isArray(data.rules)) return data.rules;
      return store.getRules();
    }).catch(function () {
      return store.getRules();
    });
  }
  return Promise.resolve(store.getRules());
}

function saveAlertRules(rules) {
  store.saveRules(rules);
  if (!preferCloud()) return Promise.resolve(rules);
  return cloud.callFunction('oilApi', { action: 'rules.save', rules: rules })
    .then(function () { return rules; })
    .catch(function () { return rules; });
}

function getAlertHistory() {
  if (preferCloud()) {
    return cloud.callFunction('oilApi', { action: 'history.list' }).then(function (data) {
      if (data && Array.isArray(data.history)) return data.history;
      return localHistory();
    }).catch(function () {
      return localHistory();
    });
  }
  return Promise.resolve(localHistory());
}

/** 本地提醒记录：用户自己的记录优先，否则用演示记录 */
function localHistory() {
  var stored = store.getHistory();
  return stored && stored.length ? stored : demo.getAlertHistory();
}

module.exports = {
  getRegions: getRegions,
  getHome: getHome,
  getTrend: getTrend,
  getNotices: getNotices,
  getMarket: getMarket,
  getAlertRules: getAlertRules,
  saveAlertRules: saveAlertRules,
  getAlertHistory: getAlertHistory,
  cloudReady: cloud.isReady,
  cloudError: cloud.lastError
};
