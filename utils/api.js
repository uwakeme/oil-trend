/**
 * 数据服务层（唯一对外取数入口）
 *
 * 设计原则：**页面只认数据结构，不认数据来源**。
 *   1. config.dataSource === 'auto' 时优先走自建后端（见 utils/cloud.js）；
 *   2. 后端不可用 / 调用失败 / 返回为空 → 自动回落本地演示数据源；
 *   3. 每次取数都会回报来源，页面据此如实展示。
 *
 * 换数据来源只需要改后端（server/），本文件与页面都不用动。
 */
const config = require('../config/index');
const cloud = require('./cloud');
const demo = require('../data/demo');
const store = require('./store');

function preferBackend() {
  return config.dataSource !== 'demo';
}

/**
 * 给返回值打上来源标记。
 *
 * 「后端配好了」不等于「这次数据来自后端」——
 * 后端失败回落到演示数据时，必须如实标成演示源。
 *
 * mode 说明：
 *   'demo'  演示数据
 *   'live'  真实数据
 *
 * 两种情况是 demo：
 *   1. 本地兜底（后端挂了，取本地演示源）
 *   2. 后端自己标的 —— 比如服务端库里还没采集到真实行情，
 *      接口返回的是演示曲线但如实标了 mode=demo。
 * 所以后端已经标了 demo 就尊重它，别覆盖成 live。
 */
function stampSource(data, mode, transport) {
  if (data && typeof data === 'object') {
    var existing = data.source || {};
    var finalMode = existing.mode === 'demo' ? 'demo' : mode;
    data.source = Object.assign({}, existing, { mode: finalMode, transport: transport });
  }
  return data;
}

/**
 * 后端返回必须带上业务字段才算成功。
 * 只判断「是不是 object」的话，后端返回 {} 会让页面拿到空数据却显示正常。
 */
function hasExpected(data, keys) {
  if (!keys || !keys.length) return true;
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]] === undefined || data[keys[i]] === null) return false;
  }
  return true;
}

/**
 * 后端优先、本地兜底
 * @param {string}   name        接口名（云函数时代的 action 名，现用于路由映射）
 * @param {object}   payload     业务参数（必须含 action）
 * @param {Function} localFn     本地兜底实现
 * @param {Array}    expectKeys  后端返回必须包含的业务字段
 */
function fetchWithFallback(name, payload, localFn, expectKeys) {
  if (preferBackend()) {
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

/**
 * 经纬度 → 省份
 *
 * 只有后端能反查（省界数据在服务端），没有本地演示版本。
 *
 * 返回 { regionCode, regionName, city, match }
 * 或 { error: 'no-match'（坐标不在支持的省份里）| 'unavailable'（后端挂了）| 'no-backend' }
 */
function locate(lat, lng) {
  if (!preferBackend()) return Promise.resolve({ error: 'no-backend' });
  return cloud.callFunction('oilApi', { action: 'locate', lat: lat, lng: lng })
    .then(function (data) {
      if (data && data.regionCode) return data;
      return { error: 'no-match' };
    })
    .catch(function () {
      return { error: 'unavailable' };
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
  if (preferBackend()) {
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
  if (!preferBackend()) return Promise.resolve(rules);
  return cloud.callFunction('oilApi', { action: 'rules.save', rules: rules })
    .then(function () { return rules; })
    .catch(function () { return rules; });
}

function getAlertHistory() {
  if (preferBackend()) {
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
  locate: locate,
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
