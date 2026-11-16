/**
 * 四油品每升幅度测算
 *
 * 发改委公告只给吨价、只分汽/柴油两类，**不给**四油品每升幅度。
 * 这个模块拿各地挂牌价的**前后快照差值**算出这次调价实际落了多少元/升，
 * 供界面标注为「据挂牌价测算」使用。
 *
 * ⚠️ 这是测算值，不是官方公布值 —— 展示层必须标注清楚，不能混进官方字段。
 *
 * 算法：
 *   1. 对每个 (地区, 油品)，在历史价序列里找**生效日附近最后一次价格变化**；
 *   2. 变化点前一条 = 调价前挂牌价，变化点 = 调价后挂牌价，差值 = 本次幅度；
 *   3. 同一个油品在各省的差值取中位数（个别省份单独调价不影响整体）。
 *
 * 为什么按「变化点」而不是按日期直接取行：
 *   来源站可能提前几天就把新挂牌价挂出来（也可能在生效日当天才挂）。
 *   按日期取行会把「生效日当天的行」当成旧价，算出来是 0 —— 误判成「持平」。
 *   找变化点则两种情况都对。
 *
 * 找不到变化点 → 这个地区这次没有可用的快照 → 不参与测算。
 */
const dao = require('../dao');

/** 一次调价的合理幅度上限（元/升）：超出算异常值，剔除 */
var MAX_REASONABLE = 0.5;

/** 至少要有几个省的数据才给结论 —— 样本太少时中位数不可信 */
var MIN_REGIONS = 3;

/** 往前看多少天找「提前挂出新价」的情况 */
var BEFORE_DAYS = 40;

/** 变化点允许比生效日早几天（站点提前挂价） */
var EARLY_DAYS = 7;

/**
 * 往后看多少天。
 *
 * 调价周期是 10 个工作日（约 14 个日历日），所以 12 天内不会出现下一轮调价，
 * 不会把下一轮的变化点算成本轮。
 */
var AFTER_DAYS = 12;

/** 日期加减天数（统一按 UTC 日历日，避免时区差一天） */
function shiftDate(dateStr, days) {
  var t = Date.parse(String(dateStr || '') + 'T00:00:00Z');
  if (!isFinite(t)) return '';
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 中位数。样本为偶数时取中间两个的平均。
 */
function median(list) {
  var arr = (list || []).slice().sort(function (a, b) { return a - b; });
  if (!arr.length) return null;
  var mid = Math.floor(arr.length / 2);
  if (arr.length % 2) return arr[mid];
  return round2((arr[mid - 1] + arr[mid]) / 2);
}

/**
 * 算一组生效日对应的四油品每升幅度。
 *
 * 返回 { 'YYYY-MM-DD': { '92': -0.13, '95': -0.13, ... } }
 * 某个油品算不出来就不出现在结果里 —— 不填 0，不填猜测值。
 */
async function measureMany(executeAtList) {
  var dates = [];
  (executeAtList || []).forEach(function (d) {
    var s = String(d || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && dates.indexOf(s) === -1) dates.push(s);
  });
  if (!dates.length) return {};

  var min = dates.reduce(function (a, b) { return a < b ? a : b; });
  var max = dates.reduce(function (a, b) { return a > b ? a : b; });
  var rows = await dao.history.listBetween(
    shiftDate(min, -BEFORE_DAYS),
    shiftDate(max, AFTER_DAYS)
  );

  // 按 地区 → 油品 → 序列 分组
  var groups = {};
  rows.forEach(function (r) {
    if (!groups[r.regionCode]) groups[r.regionCode] = {};
    if (!groups[r.regionCode][r.fuelId]) groups[r.regionCode][r.fuelId] = [];
    groups[r.regionCode][r.fuelId].push(r);
  });

  var out = {};
  dates.forEach(function (date) {
    var winStart = shiftDate(date, -EARLY_DAYS);
    var winEnd = shiftDate(date, AFTER_DAYS);
    var byFuel = {};

    Object.keys(groups).forEach(function (regionCode) {
      var fuels = groups[regionCode];
      Object.keys(fuels).forEach(function (fuelId) {
        var list = fuels[fuelId].slice().sort(function (a, b) {
          return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
        });
        // 窗口内最后一次价格变化
        var idx = -1;
        for (var i = 1; i < list.length; i++) {
          if (list[i].date < winStart) continue;
          if (list[i].date > winEnd) break;
          if (list[i].price !== list[i - 1].price) idx = i;
        }
        if (idx <= 0) return;
        var delta = round2(list[idx].price - list[idx - 1].price);
        if (!isFinite(delta) || delta === 0) return;
        // 超出一轮调价的合理幅度 → 当异常值剔除，不参与中位数
        if (Math.abs(delta) > MAX_REASONABLE) return;
        if (!byFuel[fuelId]) byFuel[fuelId] = [];
        byFuel[fuelId].push(delta);
      });
    });

    var measured = {};
    Object.keys(byFuel).forEach(function (fuelId) {
      if (byFuel[fuelId].length < MIN_REGIONS) return;
      measured[fuelId] = median(byFuel[fuelId]);
    });
    if (Object.keys(measured).length) out[date] = measured;
  });

  return out;
}

/**
 * 单个生效日的幅度。
 */
async function measureOne(executeAt) {
  var res = await measureMany([executeAt]);
  return res[String(executeAt || '').slice(0, 10)] || {};
}

/**
 * 测算值与公告方向是否一致。
 *
 * ⚠️ 不一致时不许把测算值摆出来 —— 方向矛盾说明测算用错了快照，
 * 摆出来比不摆更糟。
 */
function agreesWithDirection(measured, direction) {
  if (!measured || !Object.keys(measured).length) return false;
  if (!direction || direction === 'flat') return false;
  var want = direction === 'up' ? 1 : (direction === 'down' ? -1 : 0);
  if (!want) return false;
  var values = Object.keys(measured).map(function (k) { return measured[k]; });
  var agree = values.filter(function (v) {
    return want > 0 ? v > 0 : v < 0;
  }).length;
  return agree > 0 && agree === values.length;
}

module.exports = {
  measureMany: measureMany,
  measureOne: measureOne,
  median: median,
  agreesWithDirection: agreesWithDirection,
  shiftDate: shiftDate,
  MAX_REASONABLE: MAX_REASONABLE,
  MIN_REGIONS: MIN_REGIONS,
  EARLY_DAYS: EARLY_DAYS,
  AFTER_DAYS: AFTER_DAYS
};
