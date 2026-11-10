/**
 * 国际原油行情（演示数据）
 *
 * 说明：国际原油与国内成品油不是一个东西，价格受税费、定价周期、
 * 汇率等因素影响，只作为市场参考。单位统一为 美元/桶。
 */
const MARKETS = {
  brent: {
    symbol: 'brent',
    name: '布伦特原油',
    code: 'BRENT CRUDE · USD / BBL',
    label: '布伦特',
    price: 78.42,
    prevClose: 77.78,
    open: 77.81,
    high: 78.67,
    low: 77.56,
    changeAmount: 0.64,
    changePercent: 0.82,
    // 行情时间相对「现在」往前推，延时行情必须如实标注
    quoteMinutesAgo: 12,
    delayed: true,
    seed: 20261110
  },
  wti: {
    symbol: 'wti',
    name: '纽约原油',
    code: 'WTI CRUDE · USD / BBL',
    label: 'WTI',
    price: 74.16,
    prevClose: 74.42,
    open: 74.48,
    high: 74.73,
    low: 73.92,
    changeAmount: -0.26,
    changePercent: -0.35,
    quoteMinutesAgo: 12,
    delayed: true,
    seed: 20261111
  }
};

/**
 * 确定性伪随机数（mulberry32）：
 * 保证每次启动生成的走势曲线完全一致，不会每次刷新都在跳。
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一条从开盘价走到当前价的日内曲线。
 * @param {number} seed   随机种子
 * @param {number} open   开盘价
 * @param {number} price  当前价（曲线终点）
 * @param {number} count  点数
 */
function buildSeries(seed, open, price, count) {
  const rnd = mulberry32(seed);
  const values = [];
  const noise = Math.abs(price - open) * 0.16 + 0.22;
  let v = open;
  for (let i = 0; i < count; i++) {
    values.push(v);
    v += (rnd() - 0.5) * noise;
  }
  // 线性修正：让曲线从开盘价平滑走到当前价，
  // 否则最后一点会被强行拉成一根竖线，看着像行情跳空。
  const endDiff = price - values[count - 1];
  for (let i = 0; i < count; i++) {
    values[i] += endDiff * (i / (count - 1));
  }
  values[0] = open;
  values[count - 1] = price;
  return values;
}

module.exports = { MARKETS, buildSeries };
