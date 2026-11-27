/**
 * 调价通知详情装配
 *
 * 首页（油价页）与调价页的「调价通知详情」弹层必须给**同一份数据、同一套口径** ——
 * 两处各写一遍必然对不上账，用户一眼就能看出矛盾。
 *
 * 每升幅度按可信度依次取（每个油品单独判）：
 *   1. official 官方公布的每升幅度（发改委公告通常不给这一项）
 *   2. local    本地区挂牌价前后快照差值（实测 —— 最贴近用户所在的那个价）
 *   3. median   各省挂牌价实测差值的中位数（全国口径）
 *   4. ton      官方吨价按历史实测比值折算（非官方，只在实测拿不到时兜底）
 *
 * 调价前后价（本地区口径）：
 *   本地区有前后快照 → 直接用快照（实测）；
 *   没有快照时，**只有「当前这一轮」且挂牌价确实还没更新**才用现价推：
 *   现价当调前价，调后价 = 现价 ± 幅度（来源标「折算 / 测算」）。
 *   其余情况（当前价已是好几轮之后的价、源站数据陈旧）一律不给价 ——
 *   拿今天的价讲三轮前的调价，得到的数谁也对不上账。
 *
 * ⚠️ 折算值不是官方公布值：界面必须标明来源，不能让人把它当官方值看。
 */
const measure = require('./measure');

/** 四个油品（顺序与界面一致） */
var FUEL_IDS = ['92', '95', '98', '0'];

/** 每升幅度的来源 */
var SOURCE = {
  official: 'official',   // 官方公布的每升幅度
  forecast: 'forecast',   // 市场预测给的每升幅度（不是官方结果）
  local: 'local',         // 本地区挂牌价前后快照差值
  median: 'median',       // 各省挂牌价实测差值的中位数
  ton: 'ton'              // 官方吨价折算
};

/**
 * 官方方向 → 期望的涨跌符号：下调 -1 / 上调 1 / 不明 0。
 *
 * 用来筛掉方向相反的价格变化：变化点窗口里可能混着上一轮遗留的价差，
 * 方向不对就不是本轮的变化。
 */
function signOfDirection(direction) {
  if (direction === 'down') return -1;
  if (direction === 'up') return 1;
  return 0;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 这一轮能不能用「当前挂牌价」推算调后价。
 *
 * ⚠️ 只有两种情况可以推：
 *   1. 这轮调价还没反映到挂牌价上（当前价的最后变化早于执行日，
 *      且早得够多 —— 源站若提前几天挂出新价，当前价已经是调后价了）
 *      → 现价就是调前价，调后价 = 现价 ± 幅度；
 *   2. 执行日还没到（这轮还没调价）→ 同上。
 *
 * 其余情况一律不推：
 *   - 当前价已经含这次调价或更晚的调价 → 它讲不了这一轮的事；
 *   - 执行日过去太久（或该地区价格陈旧）→ 拿今天的价讲三轮前的调价，
 *     得到的数谁也对不上账（这种情况只给幅度，不给价）。
 *
 * @param {string} executeAt 执行日 YYYY-MM-DD
 * @param {string} changeAt  当前价的最后变化日 YYYY-MM-DD
 * @param {string} today     今天 YYYY-MM-DD
 * @returns {boolean}
 */
function canDeriveFromCurrent(executeAt, changeAt, today) {
  if (!executeAt) return false;
  // 当前价已经含这次调价（或更晚的调价）→ 不能拿它推这一轮
  if (changeAt && changeAt >= executeAt) return false;
  // 源站提前挂出新价：当前价可能已经是调后价 → 同样不能推
  if (changeAt && changeAt >= measure.shiftDate(executeAt, -measure.EARLY_DAYS)) return false;
  // 只推「当前这一轮」：执行日过去太久就别拿今天的价讲
  if (today && executeAt < measure.shiftDate(today, -measure.AFTER_DAYS)) return false;
  return true;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/**
 * 装配一条通知的对外载荷。
 *
 * @param {object} notice 通知行（dao 取出来的那条）
 * @param {object} [ctx]
 * @param {object} [ctx.measured]  这一轮各省实测差值的中位数 { fuelId: value }
 * @param {object} [ctx.snapshots] 这一轮本地区的前后快照 { fuelId: {before,after,delta} }
 * @param {object} [ctx.prices]    本地区当前挂牌价 { fuelId: { price, changeAt } }
 * @param {string}  [ctx.today]     今天 YYYY-MM-DD（决定能不能用现价推算调后价）
 * @returns {object} 通知的对外载荷
 */
function buildNotice(notice, ctx) {
  ctx = ctx || {};
  var executeAt = String(notice.executeAt || '').slice(0, 10);
  var official = notice.changes || {};
  var measured = ctx.measured || {};
  var snapshots = ctx.snapshots || {};
  var priceRows = ctx.prices || {};

  // 官方吨价折算出来的每升幅度（非官方，实测拿不到时才用）
  var converted = measure.convertedChangesOf(notice.tonChanges || {});

  // 本地区实测快照：既是本地区最贴近的幅度，也是价格表的真值
  var local = {};
  FUEL_IDS.forEach(function (fuelId) {
    var s = snapshots[fuelId];
    if (s && isNum(s.before) && isNum(s.after) && isNum(s.delta)) local[fuelId] = s;
  });

  // 每升幅度取哪一份（逐油品判定：有的油品有实测、有的没有，是常态）
  var deltas = {};
  var sources = {};
  FUEL_IDS.forEach(function (fuelId) {
    if (isNum(official[fuelId])) {
      deltas[fuelId] = official[fuelId];
      // 预测不是官方公布值，来源要分开标，不能一律说成「官方」
      sources[fuelId] = notice.kind === 'forecast' ? SOURCE.forecast : SOURCE.official;
      return;
    }
    if (local[fuelId]) {
      deltas[fuelId] = local[fuelId].delta;
      sources[fuelId] = SOURCE.local;
      return;
    }
    if (isNum(measured[fuelId])) {
      deltas[fuelId] = measured[fuelId];
      sources[fuelId] = SOURCE.median;
      return;
    }
    if (isNum(converted[fuelId])) {
      deltas[fuelId] = converted[fuelId];
      sources[fuelId] = SOURCE.ton;
      return;
    }
  });

  // 调价前后价：本地区口径
  var prices = {};
  FUEL_IDS.forEach(function (fuelId) {
    var source = sources[fuelId];
    if (!source) return;
    var delta = deltas[fuelId];
    if (local[fuelId]) {
      prices[fuelId] = {
        before: local[fuelId].before,
        after: local[fuelId].after,
        delta: local[fuelId].delta,
        basis: SOURCE.local
      };
      return;
    }
    var row = priceRows[fuelId];
    if (!row || !isNum(Number(row.price))) return;
    // 这轮还没反映到挂牌价上 → 现价是调前价，调后价按幅度推。
    // 其余情况不推（见 canDeriveFromCurrent 的注释）：
    // 拿今天的价去讲三轮前的调价，得到的数谁也对不上账。
    if (!canDeriveFromCurrent(executeAt, row.changeAt, ctx.today)) return;
    var current = Number(row.price);
    prices[fuelId] = {
      before: current,
      after: round2(current + delta),
      delta: delta,
      basis: source
    };
  });

  return {
    id: notice.id,
    kind: notice.kind,
    title: notice.title,
    publishedAt: notice.publishedAt,
    // 公告发布日（真实发布日，不是采集入库时刻）
    announcedAt: notice.announcedAt || '',
    executeAt: notice.executeAt,
    // 官方方向 up/down/flat
    direction: notice.direction || '',
    // 官方吨价（汽/柴油，元/吨）
    tonChanges: notice.tonChanges || {},
    // 官方公布的每升四油品幅度（发改委公告不给这一项）
    changes: official,
    // 挂牌价测算的每升四油品幅度（各省中位数，全国口径）—— 不是官方公布值
    measuredChanges: measured,
    changesMeasured: Object.keys(measured).length > 0,
    // 官方吨价折算出来的每升四油品幅度 —— 不是官方公布值
    convertedChanges: converted,
    changesConverted: Object.keys(converted).length > 0,
    // 最终采用的每升幅度 + 每个油品的来源
    deltas: deltas,
    deltaSource: sources,
    summary: notice.summary || '',
    // 本地区调价前后价（before / after / delta / basis）
    prices: prices,
    source: notice.source || {}
  };
}

module.exports = {
  buildNotice: buildNotice,
  signOfDirection: signOfDirection,
  canDeriveFromCurrent: canDeriveFromCurrent,
  SOURCE: SOURCE,
  FUEL_IDS: FUEL_IDS
};
