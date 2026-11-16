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
 *   3. 同一个油品在各省的差值取中位数（个别省份单独调价不影响整体）；
 *   4. 差值要落在「官方吨价换算出的合理区间」内，否则当脏数据剔除
 *      （这一轮没有官方吨价时用绝对兜底上限）。
 *
 * 为什么按「变化点」而不是按日期直接取行：
 *   来源站可能提前几天就把新挂牌价挂出来（也可能在生效日当天才挂）。
 *   按日期取行会把「生效日当天的行」当成旧价，算出来是 0 —— 误判成「持平」。
 *   找变化点则两种情况都对。
 *
 * 找不到变化点 → 这个地区这次没有可用的快照 → 不参与测算。
 */
const dao = require('../dao');

/**
 * 没有官方吨价时的绝对兜底上限（元/升）。
 *
 * ⚠️ 这里原来写死 0.5。2026-11-12 那轮官方 645 元/吨，真实降幅 0.52~0.56 元/升，
 * 全被当成异常值剔光 → 一个每升幅度都算不出来，界面等于没这功能。
 * 阈值必须跟着官方吨价走，见 boundOf()。
 */
var MAX_REASONABLE = 1.0;

/** 官方吨价 → 每升理论幅度用的密度（kg/L）：标准品是 89 号汽油、0 号车用柴油 */
var DENSITY = { gasoline: 0.725, diesel: 0.835 };

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
var FUEL_GROUP = { '92': 'gasoline', '95': 'gasoline', '98': 'gasoline', '0': 'diesel' };

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
 * 算一组生效日对应的四油品每升幅度。
 *
 * 返回 { 'YYYY-MM-DD': { '92': -0.13, '95': -0.13, ... } }
 * 某个油品算不出来就不出现在结果里 —— 不填 0，不填猜测值。
 */
async function measureMany(executeAtList, tonByDate) {
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
    // 这一轮官方给的汽/柴油吨价（没有就用绝对兜底）
    var ton = (tonByDate || {})[date] || {};
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
        // 幅度要落在官方吨价换算出的合理区间里，否则当脏数据剔除。
        // ⚠️ 上限不能写死：645 元/吨那轮真实降幅就有 0.56 元/升，
        // 写死 0.5 会把这轮所有省的数据剔光。
        var group = FUEL_GROUP[fuelId];
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
