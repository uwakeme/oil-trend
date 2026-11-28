/**
 * 国际原油行情的**品种口径**与横轴标签
 *
 * ⚠️ 这里**没有行情数据**。
 *
 * 国际行情 2026-11-28 起走真实源（纽约原油 → 东方财富，布伦特原油 → 新浪财经），
 * 数据在服务端采集，前端只认接口返回的结构。
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
 *   布伦特原油 —— 公开接口能拿到的是**场外差价合约（CFD）**报价，
 *     与 ICE 布伦特期货结算价存在基差（2026-11-27 ICE 1 月合约结算 95.44，
 *     同期 CFD 报价约 90.7）。两者都是真实报价，但不是同一个东西。
 */
const MARKET_INSTRUMENTS = {
  brent: {
    symbol: 'brent',
    name: '布伦特原油',
    code: 'BRENT',
    label: '布伦特',
    basis: '场外差价合约（CFD）报价',
    note: '布伦特为场外差价合约（CFD）报价，与 ICE 布伦特期货结算价存在基差，仅作趋势参考'
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
 * 由曲线点算出横轴三档标签（首 / 中 / 尾）。
 *
 * ⚠️ 服务端真实行情分支以前把「最后一个点的时刻」直接当 axis 用，
 * 而 axis 要的是**数组**：传字符串的话小程序 wx:for 会把字符一个个渲染出来。
 *
 * @param {Array}  points 曲线点 [{date, value}]
 * @param {string} period 周期键（'1d' 给时刻，其余给日期）
 */
function marketAxisLabels(points, period) {
  var list = points || [];
  if (!list.length) return [];
  var mode = period === '1d' ? 'time' : 'date';
  var idx = [0, Math.floor(list.length / 2), list.length - 1];
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
