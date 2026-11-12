/**
 * 本地存储：地区 / 油品 / 提醒规则 / 提醒记录
 *
 * 提醒规则同时保存在后端（跨设备生效），这里的本地副本用于
 * 离线可读与「后端未配置」时的降级展示。
 */
const { DEFAULT_REGION_CODE } = require('../data/regions');

const PREF_KEY = 'oil_trend_prefs';
const RULE_KEY = 'oil_trend_alert_rules';
const HISTORY_KEY = 'oil_trend_alert_history';

function read(key, fallback) {
  try {
    var value = wx.getStorageSync(key);
    if (value === '' || value === undefined || value === null) return fallback;
    return value;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function getPrefs() {
  var prefs = read(PREF_KEY, {});
  if (!prefs.regionCode) prefs.regionCode = DEFAULT_REGION_CODE;
  if (!prefs.fuelId) prefs.fuelId = '92';
  return prefs;
}

function setPrefs(patch) {
  // 补丁要和已有偏好合并，不能整体替换：
  // 只改油品不该把地区打回默认，只改地区也不该把油品打回 92#。
  var prefs = getPrefs();
  var next = {};
  for (var key in prefs) {
    if (Object.prototype.hasOwnProperty.call(prefs, key)) next[key] = prefs[key];
  }
  for (var patchKey in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, patchKey)) next[patchKey] = patch[patchKey];
  }
  write(PREF_KEY, next);
  return getPrefs();
}

function seedRegionIfNeeded() {
  // 首版不做强制定位，默认落在手动选择的默认地区
  return getPrefs();
}

function getRules() {
  var rules = read(RULE_KEY, []);
  return Array.isArray(rules) ? rules : [];
}

function saveRules(rules) {
  write(RULE_KEY, rules || []);
  return rules;
}

function getHistory() {
  var history = read(HISTORY_KEY, []);
  return Array.isArray(history) ? history : [];
}

function saveHistory(history) {
  write(HISTORY_KEY, history || []);
  return history;
}

/**
 * 偏好快照键：地区 + 油品。
 * 页面在 onShow 时比对，变了才重新取数 —— 用来避免首屏重复请求，
 * 也用来在别的页面改了地区/油品后自动对齐。
 */
function prefsKey(prefs) {
  var p = prefs || getPrefs();
  return (p.regionCode || '') + '/' + (p.fuelId || '');
}

module.exports = {
  getPrefs: getPrefs,
  prefsKey: prefsKey,
  setPrefs: setPrefs,
  seedRegionIfNeeded: seedRegionIfNeeded,
  getRules: getRules,
  saveRules: saveRules,
  getHistory: getHistory,
  saveHistory: saveHistory
};
