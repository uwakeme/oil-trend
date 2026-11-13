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
 * 最近一次取数的来源状态。
 *
 * 页面据此渲染「当前为演示数据 / 后端连接失败」的提示条 ——
 * 后端整体故障时必须看得见，不能静默换成演示数据装没事。
 */
var lastStatus = {
  mode: 'demo',
  name: '',
  note: '',
  transport: '',
  fellBack: false,
  reason: ''
};

function sourceStatus() {
  return lastStatus;
}

function rememberStatus(data) {
  var src = (data && data.source) || {};
  lastStatus = {
    mode: src.mode || 'demo',
    name: src.name || '',
    note: src.note || '',
    transport: src.transport || '',
    fellBack: !!src.fellBack,
    reason: src.reason || ''
  };
  return lastStatus;
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
 *
 * extra.fellBack：这次是不是「本来要用后端、后端没给成，退回演示源」。
 * extra.reason  ：退回来的原因（给页面做友好文案用，不暴露技术细节）。
 */
function stampSource(data, mode, transport, extra) {
  var opt = extra || {};
  if (data && typeof data === 'object') {
    var existing = data.source || {};
    var finalMode = existing.mode === 'demo' ? 'demo' : mode;
    data.source = Object.assign({}, existing, {
      mode: finalMode,
      transport: transport,
      fellBack: !!opt.fellBack,
      reason: opt.reason || ''
    });
  }
  rememberStatus(data);
  return data;
}

/**
 * 后端返回必须带上业务字段才算成功。
 * 只判断「是不是 object」的话，后端返回 {} 会让页面拿到空数据却显示正常。
 *
 * keys     —— 必须**存在**的字段（null / undefined 视为缺）
 * valueKeys —— 必须**有值**的字段：
 *   数组要非空，数字要有限。
 *
 * ⚠️ 两类字段要分开：通知列表为空是合法的（后端确实还没有正式公告），
 * 整包回落演示数据反而会显示假的通知；而行情曲线为空就是没数据，
 * 必须回落并如实标成演示源，不能让人以为「实时行情但曲线空白」。
 */
function hasExpected(data, keys, valueKeys) {
  if (!keys || !keys.length) return true;
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]] === undefined || data[keys[i]] === null) return false;
  }
  if (!valueKeys || !valueKeys.length) return true;
  for (var j = 0; j < valueKeys.length; j++) {
    var v = data[valueKeys[j]];
    if (v === undefined || v === null) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === 'number' && !isFinite(v)) return false;
  }
  return true;
}

/**
 * 后端优先、本地兜底
 * @param {string}   name        接口名（云函数时代的 action 名，现用于路由映射）
 * @param {object}   payload     业务参数（必须含 action）
 * @param {Function} localFn     本地兜底实现
 * @param {Array}    expectKeys  后端返回必须包含的业务字段
 * @param {Array}    valueKeys   后端返回必须有值的字段（数组非空 / 数字有限）
 */
function fetchWithFallback(name, payload, localFn, expectKeys, valueKeys) {
  if (preferBackend()) {
    return cloud.callFunction(name, payload).then(function (data) {
      if (data && typeof data === 'object' && hasExpected(data, expectKeys, valueKeys)) {
        return stampSource(data, 'live', cloud.backendName());
      }
      return stampSource(localFn(), 'demo', '本地演示源（后端返回数据不完整）', {
        fellBack: true,
        reason: '后端返回的数据不完整，已临时使用演示数据'
      });
    }).catch(function (err) {
      return stampSource(localFn(), 'demo',
        '本地演示源（后端调用失败：' + (err && err.message ? err.message : '未知原因') + '）', {
          fellBack: true,
          reason: '后端连接失败，已临时使用演示数据'
        });
    });
  }
  return Promise.resolve(stampSource(localFn(), 'demo', '本地演示源（未配置后端）', {
    fellBack: false,
    reason: ''
  }));
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
  }, ['prices', 'window'], ['prices']);
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
  }, ['points'], ['points']);
}

/**
 * 调价通知数据
 *
 * ⚠️ 通知列表**允许为空**：后端确实还没有正式公告时就是空数组，
 * 这时不能回落演示数据 —— 那会凭空造出几条假的调价通知。
 * 所以这里不校验数组长度。
 */
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
  }, ['price', 'points'], ['points']);
}

/* ---------- 提醒规则与记录 ---------- */

function getAlertRules() {
  if (preferBackend()) {
    return cloud.callFunction('oilApi', { action: 'rules.list' }).then(function (data) {
      if (data && Array.isArray(data.rules)) return data.rules;
      rememberStatus({ source: { mode: 'demo', transport: '本地演示源（后端返回数据不完整）', fellBack: true, reason: '后端返回的数据不完整，已临时使用演示数据' } });
      return store.getRules();
    }).catch(function () {
      rememberStatus({ source: { mode: 'demo', transport: '本地演示源（后端调用失败）', fellBack: true, reason: '后端连接失败，已临时使用本地记录' } });
      return store.getRules();
    });
  }
  return Promise.resolve(store.getRules());
}

/**
 * 保存提醒规则。
 *
 * @param {Array} rules 本地留存的规则（带界面状态）
 * @param {Array} [payload] 发给后端的载荷，默认与 rules 相同。
 *   两者分开是因为订阅授权是一次性的：只有「刚拿到授权」的那一次保存
 *   才带 subscribeGranted=true，之后任何保存都不带 ——
 *   否则服务端把额度用掉之后，界面上随便拨个开关就会把额度又续上，
 *   而微信那边其实已经没额度了。
 */
function saveAlertRules(rules, payload) {
  store.saveRules(rules);
  if (!preferBackend()) return Promise.resolve(rules);
  var body = payload || rules;
  return cloud.callFunction('oilApi', { action: 'rules.save', rules: body })
    .then(function () { return rules; })
    .catch(function () { return rules; });
}

function getAlertHistory() {
  if (preferBackend()) {
    return cloud.callFunction('oilApi', { action: 'history.list' }).then(function (data) {
      if (data && Array.isArray(data.history)) return data.history;
      rememberStatus({ source: { mode: 'demo', transport: '本地演示源（后端返回数据不完整）', fellBack: true, reason: '后端返回的数据不完整，已临时使用演示数据' } });
      return localHistory();
    }).catch(function () {
      rememberStatus({ source: { mode: 'demo', transport: '本地演示源（后端调用失败）', fellBack: true, reason: '后端连接失败，已临时使用本地记录' } });
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
  sourceStatus: sourceStatus,
  cloudReady: cloud.isReady,
  cloudError: cloud.lastError
};
