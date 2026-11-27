/**
 * 官方吨价 → 四油品每升幅度的折算系数
 *
 * 背景：发改委公告只给「汽油 / 柴油 元/吨」，**不给**四个油品各自的每升幅度。
 * 各地挂牌价通常在调价次日才更新，公告当天算不出实测每升幅度 ——
 * 界面就只剩「元/吨」，用户看不到每升降多少、调完是多少钱。
 *
 * 折算办法：用历史轮次里「各省挂牌价实测每升幅度 ÷ 官方吨价」的比值做标定，
 * 得到每个油品的系数（每 100 元/吨对应多少元/升），再把官方吨价乘上去。
 *
 * ⚠️ 这是**折算值**，不是官方公布值 —— 界面必须标「折算 · 非官方」。
 *   源站挂出新挂牌价后，实测值会自动接管；折算值只在实测值缺位时兜底。
 *
 * ⚠️ 系数有适用范围：它标定的是「标准品吨价 → 各标号每升挂牌价」这条链路，
 *   各地定价机制改了就必须重新标定。数据来源见 CALIBRATION_ROUNDS。
 *
 * 标定结果（2026 年三轮真实调价，各省挂牌价实测差值的中位数）：
 *   官方吨价 645 元/吨 → 92# 0.52 / 95# 0.55 / 98# 0.56 元/升
 *   官方吨价 395 元/吨 → 92# 0.32 / 95# 0.34 / 98# 0.34 元/升
 *   官方吨价 345 元/吨 → 92# 0.28 / 95# 0.29 / 98# 0.30 元/升
 * 柴油同理（官方吨价 625 / 385 / 335 元/吨 → 0.54 / 0.33 / 0.29 元/升）。
 *
 * 单一真源：服务端副本由 scripts/sync-shared.js 生成
 * （server/src/shared/shared.js），改完必须重跑同步脚本。
 */

/** 油品 → 官方吨价分类（92/95/98 是汽油，0 是柴油） */
var FUEL_GROUP = { '92': 'gasoline', '95': 'gasoline', '98': 'gasoline', '0': 'diesel' };

/** 标准品密度（kg/L）：标准品是 89 号汽油、0 号车用柴油 */
var DENSITY = { gasoline: 0.725, diesel: 0.835 };

/**
 * 每 100 元/吨对应多少元/升（按油品分别标定）。
 *
 * 为什么按油品分别标定：各省标号结构不同（98# 相对 92# 的溢价各省差 1.3 元/升），
 * 共用一套系数误差最大能到 0.02 元/升。
 *
 * 数量级对照：标准品理论值 = 元/吨 ÷ 1000 × 密度（89# 汽油 0.725 kg/L），
 * 645 元/吨 ≈ 0.47 元/升；实测 92# 是 0.52，比值 ≈ 1.11 —— 各标号另有质量差额与密度差异。
 */
var LITER_PER_100TON = {
  '92': 0.0810,
  '95': 0.0853,
  '98': 0.0868,
  '0': 0.0864
};

/**
 * 标定用的真实轮次（反向验证用）。
 *
 * measured 是那一轮**各省挂牌价实测差值的中位数**（全国口径），
 * ton 是那一轮发改委公告给出的汽/柴油吨价。
 * 换算函数必须把这 12 个值（4 油品 × 3 轮次）逐项复现 —— 对不上一处，
 * 说明系数写错了或公告口径变了。
 */
var CALIBRATION_ROUNDS = [
  {
    date: '2026-09-24',
    ton: { gasoline: 395, diesel: 385 },
    measured: { '92': 0.32, '95': 0.34, '98': 0.34, '0': 0.33 }
  },
  {
    date: '2026-10-29',
    ton: { gasoline: 345, diesel: 335 },
    measured: { '92': 0.28, '95': 0.29, '98': 0.30, '0': 0.29 }
  },
  {
    date: '2026-11-12',
    ton: { gasoline: 645, diesel: 625 },
    measured: { '92': 0.52, '95': 0.55, '98': 0.56, '0': 0.54 }
  }
];

/**
 * 保留两位小数。
 *
 * ⚠️ 这里不用 round2：生成产物 shared.js 的顶层已经有一个 round2，
 *   两份同名函数在同一个作用域里会互相覆盖。生成时这段代码被包在 IIFE 里，
 *   但独立使用（data/ton-conversion.js）时保持独立命名更稳妥。
 */
function roundCent(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 官方吨价 → 某个油品的每升折算幅度。
 *
 * @param {object} tonChanges { gasoline: -440, diesel: -425 }（元/吨，负数是下调）
 * @param {string} fuelId     '92' | '95' | '98' | '0'
 * @returns {number|null} 元/升；没有对应吨价时返回 null（不猜）
 */
function convertTonToLiter(tonChanges, fuelId) {
  var group = FUEL_GROUP[fuelId];
  if (!group) return null;
  var ton = Number((tonChanges || {})[group]);
  if (!isFinite(ton) || ton === 0) return null;
  var k = LITER_PER_100TON[fuelId];
  if (!k) return null;
  return roundCent(ton / 100 * k);
}

/**
 * 官方吨价 → 四个油品的每升折算幅度。
 *
 * 没有对应吨价的油品不出现（不给 0，也不猜）。
 *
 * @param {object} tonChanges { gasoline: -440, diesel: -425 }
 * @returns {object} { '92': -0.36, '95': -0.38, '98': -0.38, '0': -0.37 }
 */
function convertTonToLiterAll(tonChanges) {
  var out = {};
  Object.keys(LITER_PER_100TON).forEach(function (fuelId) {
    var value = convertTonToLiter(tonChanges, fuelId);
    if (value !== null) out[fuelId] = value;
  });
  return out;
}

module.exports = {
  FUEL_GROUP: FUEL_GROUP,
  DENSITY: DENSITY,
  LITER_PER_100TON: LITER_PER_100TON,
  CALIBRATION_ROUNDS: CALIBRATION_ROUNDS,
  convertTonToLiter: convertTonToLiter,
  convertTonToLiterAll: convertTonToLiterAll
};
