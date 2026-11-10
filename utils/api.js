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

var lastSource = 'demo';

function preferCloud() {
  return config.dataSource !== 'demo';
}

/**
 * 云端优先、本地兜底
 * @param {string}   name      云函数名
 * @param {object}   payload   云函数入参
 * @param {Function} localFn   本地兜底实现
 */
function fetchWithFallback(name, payload, localFn) {
  if (preferCloud()) {
    return cloud.callFunction(name, payload).then(function (data) {
      if (data && typeof data === 'object') {
        lastSource = 'cloud';
        return data;
      }
      lastSource = 'demo';
      return localFn();
    }).catch(function () {
      lastSource = 'demo';
      return localFn();
    });
  }
  lastSource = 'demo';
  return Promise.resolve(localFn());
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
  });
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
  });
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
  });
}

/** 国际行情 */
function getMarket(symbol, period) {
  return fetchWithFallback('oilApi', { action: 'market', symbol: symbol, period: period }, function () {
    return demo.getMarket(symbol, period);
  });
}

/* ---------- 提醒规则与记录 ---------- */

function getAlertRules() {
  if (preferCloud()) {
    return cloud.callFunction('oilApi', { action: 'rules.list' }).then(function (data) {
      if (data && Array.isArray(data.rules)) {
        lastSource = 'cloud';
        return data.rules;
      }
      lastSource = 'demo';
      return store.getRules();
    }).catch(function () {
      lastSource = 'demo';
      return store.getRules();
    });
  }
  lastSource = 'demo';
  return Promise.resolve(store.getRules());
}

function saveAlertRules(rules) {
  store.saveRules(rules);
  if (!preferCloud()) return Promise.resolve(rules);
  return cloud.callFunction('oilApi', { action: 'rules.save', rules: rules })
    .then(function () { lastSource = 'cloud'; return rules; })
    .catch(function () { lastSource = 'demo'; return rules; });
}

function getAlertHistory() {
  if (preferCloud()) {
    return cloud.callFunction('oilApi', { action: 'history.list' }).then(function (data) {
      if (data && Array.isArray(data.history)) {
        lastSource = 'cloud';
        return data.history;
      }
      lastSource = 'demo';
      return localHistory();
    }).catch(function () {
      lastSource = 'demo';
      return localHistory();
    });
  }
  lastSource = 'demo';
  return Promise.resolve(localHistory());
}

/** 本地提醒记录：用户自己的记录优先，否则用演示记录 */
function localHistory() {
  var stored = store.getHistory();
  return stored && stored.length ? stored : demo.getAlertHistory();
}

function saveAlertHistory(history) {
  store.saveHistory(history);
  if (!preferCloud()) return Promise.resolve(history);
  return cloud.callFunction('oilApi', { action: 'history.save', history: history })
    .then(function () { lastSource = 'cloud'; return history; })
    .catch(function () { lastSource = 'demo'; return history; });
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
  saveAlertHistory: saveAlertHistory,
  cloudReady: cloud.isReady,
  cloudError: cloud.lastError,
  get lastSource() { return lastSource; }
};
