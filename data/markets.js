/**
 * 国际原油行情的**品种口径**与横轴标签
 *
 * ⚠️ 这里**没有行情数据**。
 *
 * 国际行情 2026-11-28 起走真实源（纽约原油 → 东方财富 NYMEX 近月，
 * 布伦特原油 → 东方财富 IPE 当月连续），数据在服务端采集，
 * 前端只认接口返回的结构。
 *
 * 以前这个文件放着一整套**演示载荷**：写死的 78.42 / 74.16，
 * 曲线是 mulberry32 伪随机生成的，时间戳却按「现在」打。
 * 后端没采到行情时回落到它 —— 用户看到的是「刚更新的实时行情」，却是假的。
 * 演示数据已删：采不到就是采不到，界面显示空态并说明原因。
 *
 * 说明：国际原油与国内成品油不是一个东西，价格受税费、定价周期、
 * 汇率等因素影响，只作为市场参考。单位统一为 美元/桶。
 */

/**
 * 品种口径（展示层固定说法，与具体来源无关）
 *
 * ⚠️ 真源在这里：服务端共享副本由 scripts/sync-shared.js 从本文件生成。
 *
 * 为什么要有这一份：两个国际品种的**口径并不一样**，不写清楚用户只会
 * 觉得「页面上的数和新闻里的数又对不上」：
 *   纽约原油 —— NYMEX 近月（当月连续）合约；
 *   布伦特原油 —— IPE（ICE 布伦特）当月连续合约。
 *
 * ⚠️ 布伦特 2026-11-28 从新浪 hf_OIL 换到东财 IPE 合约：
 *    新浪那边是**场外差价合约（CFD）**报价，与 ICE 结算价差 4~5 美元，
 *    而且公开接口没有历史序列，画不出曲线。换成 IPE 合约后口径更贴近新闻，
 *    曲线也拿得到。与 ICE 结算价仍有合约基差（2026-11-27：结算 95.44，
 *    IPE 当月连续约 90.8），那是正常的，不是谁错了。
 */
const MARKET_INSTRUMENTS = {
  brent: {
    symbol: 'brent',
    name: '布伦特原油',
    code: 'BRENT',
    label: '布伦特',
    basis: 'ICE 布伦特当月连续（IPE）合约',
    note: '布伦特为 IPE（ICE 布伦特）当月连续合约报价，与 ICE 布伦特期货结算价仍有合约基差，仅作趋势参考'
  },
  wti: {
    symbol: 'wti',
    name: '纽约原油',
    code: 'WTI',
    label: 'WTI',
    basis: 'NYMEX 近月（当月连续）合约',
    note: '纽约原油为 NYMEX 近月（当月连续）合约报价，与布伦特不是同一品种口径'
  }
};

/** 轴标签：日内给 HH:MM，跨日给 MM-DD */
function marketAxisLabel(dateStr, mode) {
  if (mode === 'time') return String(dateStr).slice(11, 16);
  return String(dateStr).slice(5, 10);
}

/**
 * 'YYYY-MM-DD' / 'YYYY-MM-DD HH:mm:ss' → 时间戳（UTC）。
 *
 * ⚠️ 跟 utils/chart.js 的 toTimestamp 是同一套口径：
 *    轴标签说「哪个时刻」，图上就画在哪个时刻上。
 */
function axisTimestamp(dateStr) {
  var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
    m[6] ? Number(m[6]) : 0);
}

/**
 * 中间那个点取**时间中点**，不是序号中点。
 *
 * ⚠️ 为什么：横坐标是按真实时刻比例排的（utils/chart.js 的 computeXs），
 *    而行情曲线里最近两天的分钟线点占了一大半（1 月视图 340 个点里 265 个是分钟线）。
 *    按序号取中点会落在 98% 的位置 —— 标签画在图的正中间，
 *    说的却是图最右边那个点的时刻，看着像标错，其实是指错了点。
 */
function middleIndexByTime(list) {
  var fallback = Math.floor(list.length / 2);
  var t0 = axisTimestamp((list[0] || {}).date);
  var t1 = axisTimestamp((list[list.length - 1] || {}).date);
  if (t0 === null || t1 === null || t1 <= t0) return fallback;
  var mid = t0 + (t1 - t0) / 2;
  var best = fallback;
  var bestDiff = Infinity;
  for (var i = 0; i < list.length; i++) {
    var t = axisTimestamp((list[i] || {}).date);
    if (t === null) continue;
    var diff = Math.abs(t - mid);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/**
 * 由曲线点算出横轴三档标签（首 / 中 / 尾）。
 *
 * ⚠️ 服务端真实行情分支以前把「最后一个点的时刻」直接当 axis 用，
 * 而 axis 要的是**数组**：传字符串的话小程序 wx:for 会把字符一个个渲染出来。
 *
 * ⚠️ 中档标签取**时间中点**的那个点：图上的横坐标是按真实时刻比例排的，
 * 中档标签要跟着横坐标走，按序号取会指错点（见 middleIndexByTime）。
 *
 * @param {Array}  points 曲线点 [{date, value}]
 * @param {string} period 周期键（'1d' 给时刻，其余给日期）
 */
function marketAxisLabels(points, period) {
  var list = points || [];
  if (!list.length) return [];
  var mode = period === '1d' ? 'time' : 'date';
  var idx = [0, middleIndexByTime(list), list.length - 1];
  return idx.map(function (i) {
    var d = String((list[i] || {}).date || '');
    // 纯日期的点（日 K）在「1 日」视图里没有时刻可显示 → 退回日期
    if (mode === 'time' && d.length <= 10) return marketAxisLabel(d, 'date');
    return marketAxisLabel(d, mode);
  });
}

module.exports = {
  MARKET_INSTRUMENTS,
  marketAxisLabels
};
