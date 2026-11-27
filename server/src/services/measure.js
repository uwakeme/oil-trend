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
 *   1. 对每个 (地区, 油品)，在历史价序列里找**生效日附近的价格变化**；
 *   2. 变化点前一条 = 调价前挂牌价，变化点 = 调价后挂牌价，差值 = 本次幅度；
 *   3. 同一个油品在各省的差值取中位数（个别省份单独调价不影响整体）；
 *   4. 差值要落在「官方吨价换算出的合理区间」内，否则当脏数据剔除
 *      （这一轮没有官方吨价时用绝对兜底上限）。
 *
 * 为什么按「变化点」而不是按日期直接取行：
 *   来源站可能提前几天就把新挂牌价挂出来（也可能在生效日当天才挂）。
 *   按日期取行会把「生效日当天的行」当成旧价，算出来是 0 —— 误判成「持平」。
 *   找变化点则两种情况都对。
 *
 * 为什么变化点取「离生效日最近」的，而不是窗口里的最后一个：
 *   下一轮的价格可能提前挂出来，落进本轮的 +12 天窗口；
 *   取最后一个就把下一轮的变化点算成本轮的 —— 归错轮次。
 *   详见 changePointAt() 的注释。
 *
 * 找不到变化点 → 这个地区这次没有可用的快照 → 不参与测算。
 */
const dao = require('../dao');
// 密度与油品分组：真源在 data/ton-conversion.js，服务端副本由 scripts/sync-shared.js 生成
const shared = require('../shared/shared');

/**
 * 没有官方吨价时的绝对兜底上限（元/升）。
 *
 * ⚠️ 这里原来写死 0.5。2026-11-12 那轮官方 645 元/吨，真实降幅 0.52~0.56 元/升，
 * 全被当成异常值剔光 → 一个每升幅度都算不出来，界面等于没这功能。
 * 阈值必须跟着官方吨价走，见 boundOf()。
 */
var MAX_REASONABLE = 1.0;

/** 官方吨价 → 每升理论幅度用的密度（kg/L）：标准品是 89 号汽油、0 号车用柴油 */
var DENSITY = shared.TON_CONVERSION.DENSITY;

/**
 * 允许偏差比例：实测与理论值的差。
 *
 * 官方给的是标准品吨价，各标号另有质量差额、密度也不同，
 * 实测本来就会偏离理论值 —— 2026-11-12 那轮理论 0.47，实测 0.52~0.56。
 */
var TOL_RATIO = 0.35;

/** 允许偏差的绝对下限（元/升）：挂牌价只精确到 0.01，容差太窄会把小调价也剔掉 */
var TOL_FLOOR = 0.15;

/** 油品 → 官方吨价分类（92/95/98 是汽油，0 是柴油） */
var FUEL_GROUP = shared.TON_CONVERSION.FUEL_GROUP;

/** 至少要有几个省的数据才给结论 —— 样本太少时中位数不可信 */
var MIN_REGIONS = 3;

/**
 * 跨省一致性的两个上限。
 *
 * 区间定界挡的是「这个省的值离谱」（源站快照陈旧、被剔）；
 * 这里挡的是「整体都乱」—— 比如源站改了页面结构、或者大半省的快照是陈旧值，
 * 这种情况下中位数本身也不可信，不能拿一个看着合理的数字当结论。
 *
 * ⚠️ 2026-11-12 那轮 98# 各省实测 -0.36 ~ -0.97（河南、海南的调价前快照是陈旧值），
 * 剔掉脏值后 28 省的 MAD 只有 0.010 —— 门槛定太紧会把正常的轮次也毙掉。
 */
var MAX_MAD = 0.08;
var MAX_MAD_RATIO = 0.15;

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
 * 按官方吨价算出这一轮允许的每升幅度区间。
 *
 * 官方给的是标准品吨价（89 号汽油 / 0 号车用柴油），折成每升是「理论值」；
 * 各标号另有质量差额、密度也不同，实测会偏离理论值，所以给一个容差带。
 *
 * 实测 2026-11-12 那轮：官方 645 元/吨 → 理论 0.47 元/升，
 * 区间 [0.30, 0.63]；实测 92# 0.52 / 95# 0.55 / 98# 0.56 都在带内，
 * 而海南 98# 那种 -0.97 的脏数据落在带外，被剔掉。
 *
 * 没有官方吨价时返回 null —— 调用方改用绝对兜底上限。
 */
function boundOf(tonAmount, group) {
  var ton = Math.abs(Number(tonAmount));
  if (!isFinite(ton) || ton <= 0) return null;
  var rho = DENSITY[group] || DENSITY.gasoline;
  var theo = ton / 1000 * rho;
  var tol = Math.max(theo * TOL_RATIO, TOL_FLOOR);
  return {
    theo: round2(theo),
    min: Math.max(0, round2(theo - tol)),
    max: round2(theo + tol)
  };
}

/**
 * 找生效日附近的**价格变化**（变化点）。
 *
 * ⚠️ 不能按日期直接取行：来源站可能提前几天就把新挂牌价挂出来，
 * 按「生效日当天的行」取会拿到新价，算出来是 0（误判成持平）。
 *
 * ⚠️ 也不能取窗口里的**最后一个**变化点：下一轮的价格可能提前挂出来，
 * 落进本轮的 +12 天窗口，取最后一个就把下一轮的变化点算成本轮的 ——
 * 历史通知的前后价、本地区幅度、各省中位数全都归错轮次。
 *
 * 现在的选取规则：
 *   1. 窗口 = [生效日 - 7 天, 生效日 + 12 天]，且不得越过下一轮执行日；
 *   2. 已知官方方向时，方向相反的候选直接剔掉
 *      （窗口里可能混着上一轮遗留的价差，方向不对就不是本轮的变化）；
 *   3. 剩下的候选取**离生效日最近**的那个；距离相同时取靠后的那个
 *      —— 生效日前后的变化属于本轮，下一轮的提前挂价一定更靠后。
 *
 * 找不到变化点 → null（这个地区这次没有可用的快照，不编数字）。
 *
 * @param {Array}  list 同一 (地区, 油品) 的历史价行，按日期升序
 * @param {string} date  生效日 YYYY-MM-DD
 * @param {object} [opts]
 * @param {number} [opts.expectSign] 期望的涨跌方向：-1 降 / 1 涨 / 0 不限
 * @param {string} [opts.nextDate]   下一轮执行日，变化点不得越过它
 * @returns {object|null} { before, after, delta, date }
 */
function changePointAt(list, date, opts) {
  opts = opts || {};
  var expectSign = Number(opts.expectSign) || 0;
  var winStart = shiftDate(date, -EARLY_DAYS);
  var winEnd = shiftDate(date, AFTER_DAYS);
  // 下一轮执行日之前才算本轮：变化点不得进入下一轮
  if (opts.nextDate && opts.nextDate > date) {
    var nextStart = shiftDate(opts.nextDate, -1);
    if (nextStart < winEnd) winEnd = nextStart;
  }
  var bestIndex = -1;
  var bestDist = Infinity;
  for (var i = 1; i < list.length; i++) {
    if (list[i].date < winStart) continue;
    if (list[i].date > winEnd) break;
    if (list[i].price === list[i - 1].price) continue;
    var before = Number(list[i - 1].price);
    var after = Number(list[i].price);
    if (!isFinite(before) || !isFinite(after)) continue;
    var delta = round2(after - before);
    if (!delta) continue;
    // 方向与官方公布的方向相反 → 不是本轮的变化点
    if (expectSign && (delta > 0 ? 1 : -1) !== expectSign) continue;
    var dist = Math.abs(dayDiff(date, list[i].date));
    // ⚠️ 取**离执行日最近**的变化点，不是最后一个；
    // 距离相同时取靠后的那个（生效日前后的变化属于本轮，下一轮的提前挂价更靠后）。
    if (dist <= bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  if (bestIndex <= 0) return null;
  var prevPrice = Number(list[bestIndex - 1].price);
  var nextPrice = Number(list[bestIndex].price);
  if (!isFinite(prevPrice) || !isFinite(nextPrice)) return null;
  return {
    before: prevPrice,
    after: nextPrice,
    delta: round2(nextPrice - prevPrice),
    date: list[bestIndex].date
  };
}

/** 两个 YYYY-MM-DD 之间差几天 */
function dayDiff(fromDate, toDate) {
  var a = Date.parse(String(fromDate || '').slice(0, 10) + 'T00:00:00Z');
  var b = Date.parse(String(toDate || '').slice(0, 10) + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * 某个 (地区, 油品) 在生效日附近的本地区前后快照。
 *
 * 与各省中位数是**两回事**：这里给的是这个地区自己的挂牌价前后差值，
 * 「本地区调整前多少钱、调整后多少钱」只能从这里来。
 *
 * @param {object} [opts] 透传给 changePointAt（expectSign 期望方向、nextDate 下一轮执行日）
 * @returns {Promise<object|null>} { before, after, delta, date }；没有快照返回 null
 */
async function localSnapshotOf(regionCode, fuelId, executeAt, opts) {
  var date = String(executeAt || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  var rows = await dao.history.listByRegionFuel(regionCode, fuelId, shiftDate(date, -BEFORE_DAYS));
  var list = (rows || []).slice().sort(function (a, b) {
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });
  return changePointAt(list, date, opts);
}

/**
 * 一次算出某个地区在若干生效日上的前后快照（按油品分组）。
 *
 * 通知详情要按「这一轮调价前后各多少钱」展示，
 * 不能拿当前价倒推 —— 倒推出来的是猜的。
 *
 * @param {object} [opts]
 * @param {object} [opts.expectSignByDate] { 'YYYY-MM-DD': -1|1 } 各生效日的官方方向
 * @returns {Promise<object>} { 'YYYY-MM-DD': { fuelId: {before,after,delta,date} } }
 */
async function localSnapshotsOf(executeAtList, regionCode, opts) {
  opts = opts || {};
  var signByDate = opts.expectSignByDate || {};
  var out = {};
  var dates = [];
  (executeAtList || []).forEach(function (d) {
    var s = String(d || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && dates.indexOf(s) === -1) dates.push(s);
  });
  if (!dates.length) return out;
  dates.sort();
  var min = dates[0];
  var fuels = Object.keys(FUEL_GROUP);
  for (var f = 0; f < fuels.length; f++) {
    var rows = await dao.history.listByRegionFuel(regionCode, fuels[f], shiftDate(min, -BEFORE_DAYS));
    var list = (rows || []).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
    for (var i = 0; i < dates.length; i++) {
      var date = dates[i];
      // 下一轮执行日：变化点不得越过它（否则下一轮的提前挂价会被算成本轮）
      var nextDate = null;
      for (var j = i + 1; j < dates.length; j++) {
        if (dates[j] > date) { nextDate = dates[j]; break; }
      }
      var point = changePointAt(list, date, {
        expectSign: Number(signByDate[date]) || 0,
        nextDate: nextDate
      });
      if (!point) continue;
      if (!out[date]) out[date] = {};
      out[date][fuels[f]] = point;
    }
  }
  return out;
}

/**
 * 算一组生效日对应的四油品每升幅度。
 *
 * 返回 { 'YYYY-MM-DD': { '92': -0.13, '95': -0.13, ... } }
 * 某个油品算不出来就不出现在结果里 —— 不填 0，不填猜测值。
 *
 * @param {Array} executeAtList 要测算的生效日
 * @param {object} tonByDate    各生效日的官方吨价
 * @param {string} [nextExecDate] **视图之外**的下一轮执行日。
 *   发改委提前约 10 天公布下一轮，那条公告的生效日在未来、不会进测算列表，
 *   但它必须当变化点窗口的边界用 —— 少了它，窗口会放开到 +12 天，
 *   下一轮的价格变化会被算成这一轮的幅度（每升幅度整轮错位）。
 */
async function measureMany(executeAtList, tonByDate, nextExecDate) {
  var dates = [];
  (executeAtList || []).forEach(function (d) {
    var s = String(d || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && dates.indexOf(s) === -1) dates.push(s);
  });
  if (!dates.length) return {};
  dates.sort();

  var min = dates[0];
  var max = dates[dates.length - 1];
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
  // 每个地区油品序列只排序一次，后续各生效日共用，避免 dates × groups 次重复排序。
  Object.keys(groups).forEach(function (regionCode) {
    Object.keys(groups[regionCode]).forEach(function (fuelId) {
      groups[regionCode][fuelId].sort(function (a, b) {
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });
    });
  });

  var out = {};
  dates.forEach(function (date) {
    // 这一轮官方给的汽/柴油吨价（没有就用绝对兜底）
    var ton = (tonByDate || {})[date] || {};
    var byFuel = {};
    // 下一轮执行日：变化点不得越过它
    var nextDate = null;
    for (var di = 0; di < dates.length; di++) {
      if (dates[di] > date) { nextDate = dates[di]; break; }
    }
    // 测算列表里没有下一轮时，用**视图外**最近的未来执行日兜底。
    // ⚠️ 少了这一步，下一轮的提前挂价会落进本轮的 +12 天窗口，
    //   本轮自己的变化点找不到时，就会拿下一轮的价差当本轮幅度。
    if (!nextDate && nextExecDate && nextExecDate > date) nextDate = nextExecDate;

    Object.keys(groups).forEach(function (regionCode) {
      var fuels = groups[regionCode];
      Object.keys(fuels).forEach(function (fuelId) {
        var list = fuels[fuelId];
        // 窗口内的价格变化（与本地区快照同一套算法，别各写一遍）
        // 官方方向已知时，方向相反的候选不算本轮的变化点
        var group = FUEL_GROUP[fuelId];
        var tonValue = Number(ton[group]);
        var expectSign = (isFinite(tonValue) && tonValue !== 0) ? (tonValue > 0 ? 1 : -1) : 0;
        var point = changePointAt(list, date, {
          expectSign: expectSign,
          nextDate: nextDate
        });
        if (!point) return;
        var delta = point.delta;
        if (!isFinite(delta) || delta === 0) return;
        // 幅度要落在官方吨价换算出的合理区间里，否则当脏数据剔除。
        // ⚠️ 上限不能写死：645 元/吨那轮真实降幅就有 0.56 元/升，
        // 写死 0.5 会把这轮所有省的数据剔光。
        var bound = boundOf(ton[group], group);
        var maxAbs = bound ? bound.max : MAX_REASONABLE;
        var minAbs = bound ? bound.min : 0;
        if (Math.abs(delta) > maxAbs) return;
        // 官方说降了这么多，实测却几乎没动 → 抓错了快照，不参与中位数
        if (Math.abs(delta) < minAbs) return;
        if (!byFuel[fuelId]) byFuel[fuelId] = [];
        byFuel[fuelId].push(delta);
      });
    });

    var measured = {};
    Object.keys(byFuel).forEach(function (fuelId) {
      if (byFuel[fuelId].length < MIN_REGIONS) return;
      var list = byFuel[fuelId];
      var med = median(list);
      // 跨省离散太大 → 中位数也不可信，这个油品不摆数值
      var mad = median(list.map(function (v) { return Math.abs(v - med); }));
      if (mad > MAX_MAD && mad > Math.abs(med) * MAX_MAD_RATIO) {
        console.warn('[measure] ' + date + ' ' + fuelId + ' 各省数据离散（MAD=' + mad +
          '，中位=' + med + '），不采用测算值');
        return;
      }
      measured[fuelId] = med;
    });
    if (Object.keys(measured).length) out[date] = measured;
  });

  return out;
}

/**
 * 单个生效日的幅度。
 */
async function measureOne(executeAt, tonChanges) {
  var date = String(executeAt || '').slice(0, 10);
  var tonByDate = {};
  if (date) tonByDate[date] = tonChanges || {};
  var res = await measureMany([executeAt], tonByDate);
  return res[date] || {};
}

/**
 * 官方吨价 → 四油品每升折算值。
 *
 * ⚠️ 这是**折算值**，不是官方公布值：系数取历史轮次「实测每升 ÷ 官方吨价」的
 *   比值中位数（真源在 data/ton-conversion.js）。各地挂牌价通常在调价次日才更新，
 *   公告当天算不出实测幅度，这时用折算值兜底，界面上必须标「折算 · 非官方」。
 *
 * @param {object} tonChanges { gasoline: -440, diesel: -425 }（元/吨）
 * @returns {object} { '92': -0.36, ... }；没有对应吨价的油品不出现
 */
function convertedChangesOf(tonChanges) {
  return shared.TON_CONVERSION.convertTonToLiterAll(tonChanges || {});
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
  convertedChangesOf: convertedChangesOf,
  measureOne: measureOne,
  localSnapshotOf: localSnapshotOf,
  localSnapshotsOf: localSnapshotsOf,
  changePointAt: changePointAt,
  dayDiff: dayDiff,
  median: median,
  agreesWithDirection: agreesWithDirection,
  shiftDate: shiftDate,
  boundOf: boundOf,
  MAX_REASONABLE: MAX_REASONABLE,
  DENSITY: DENSITY,
  TOL_RATIO: TOL_RATIO,
  TOL_FLOOR: TOL_FLOOR,
  MAX_MAD: MAX_MAD,
  MAX_MAD_RATIO: MAX_MAD_RATIO,
  FUEL_GROUP: FUEL_GROUP,
  MIN_REGIONS: MIN_REGIONS,
  EARLY_DAYS: EARLY_DAYS,
  AFTER_DAYS: AFTER_DAYS
};
