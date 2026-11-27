/**
 * 服务端共享模块 —— 由 scripts/sync-shared.js 自动生成，请勿手改。
 *
 * 数据真源在小程序端 data/ 下：
 *   data/adjustments.js  调价时间线（全国统一幅度）
 *   data/regions.js      地区价差
 *   data/fuels.js        油品定义
 *   data/adjust-cycle.js 调价周期推算（节假日表 + 下一轮调价日）
 *
 * 改了上面任意一个文件，都要重新跑 scripts/sync-shared.js。
 * 只有这一份副本，供自建后端（server/）使用。
 */

/* ---------- 行情（来自 data/markets.js，两端共用同一份实现） ---------- */

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

/**
 * 行情周期配置
 *
 * stepMinutes：相邻两个点的真实间隔，1 日按 15 分钟、其余按 1 天。
 * 以前不管切哪个周期都按分钟间隔造点，切周期只是点数变了，曲线没区别。
 */
const MARKET_PERIODS = {
  '1d': { label: '1日', points: 28, stepMinutes: 15,   fromOpen: true, axis: 'time' },
  '1w': { label: '1周', points: 7,  stepMinutes: 1440, ratio: 0.982, axis: 'date' },
  '1m': { label: '1月', points: 30, stepMinutes: 1440, ratio: 0.958, axis: 'date' },
  '3m': { label: '3月', points: 90, stepMinutes: 1440, ratio: 0.914, axis: 'date' }
};

/** 轴标签：日内给 HH:MM，跨日给 MM-DD */
function marketAxisLabel(dateStr, mode) {
  if (mode === 'time') return String(dateStr).slice(11, 16);
  return String(dateStr).slice(5, 10);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 某个时刻在 UTC+8 下的日历字段。
 *
 * 小程序端在东八区、服务器可能在 UTC，两端各按本地时间打时间戳会错位，
 * 这里统一按 UTC+8 取字段。
 */
function utc8Parts(date) {
  var t = new Date(date.getTime() + 8 * 3600000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds()
  };
}

/**
 * 组装一个品种的完整行情载荷。
 *
 * 小程序端和服务端共用这一份实现（服务端副本由 scripts/sync-shared.js
 * 从本文件内联生成），避免两端再次分叉。
 */
function buildMarketPayload(symbol, period) {
  var key = MARKETS[symbol] ? symbol : 'brent';
  var m = MARKETS[key];
  var conf = MARKET_PERIODS[period] || MARKET_PERIODS['1d'];

  var start = conf.fromOpen ? m.open : round2(m.price * conf.ratio);
  var raw = buildSeries(m.seed + key.length + period.length, start, m.price, conf.points);
  var now = new Date();
  var quoteTime = new Date(now.getTime() - (m.quoteMinutesAgo || 0) * 60000);

  // 图表用的完整日期时间：带年份，横轴才能按真实时间比例排
  function fullStamp(d) {
    var p = utc8Parts(d);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + ' ' +
      pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
  }
  // 界面展示用的短格式
  function shortStamp(d) {
    var p = utc8Parts(d);
    return pad2(p.month) + '-' + pad2(p.day) + ' ' +
      pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
  }

  var step = (conf.stepMinutes || 15) * 60000;
  var points = raw.map(function (v, i) {
    var d = new Date(quoteTime.getTime() - (conf.points - 1 - i) * step);
    return { date: fullStamp(d), value: Number(v.toFixed(2)) };
  });

  return {
    symbol: key,
    name: m.name,
    code: m.code,
    label: m.label,
    price: m.price,
    changeAmount: m.changeAmount,
    changePercent: m.changePercent,
    // 三态：涨跌额为 0 是「持平」，不能染成上涨。
    // openapi 声明的就是三态，生成源这里也得是三态 ——
    // sync-shared 只保证两端「一致」，两端一致地写错它不会报警。
    direction: m.changeAmount < 0 ? 'down' : (m.changeAmount > 0 ? 'up' : 'flat'),
    open: m.open,
    prevClose: m.prevClose,
    high: m.high,
    low: m.low,
    unit: '美元/桶',
    quoteTime: shortStamp(quoteTime),
    delayed: !!m.delayed,
    delayMinutes: m.quoteMinutesAgo || 0,
    period: conf.label,
    points: points,
    axis: [
      points[0] ? marketAxisLabel(points[0].date, conf.axis) : '',
      points[Math.floor(points.length / 2)] ? marketAxisLabel(points[Math.floor(points.length / 2)].date, conf.axis) : '',
      points[points.length - 1] ? marketAxisLabel(points[points.length - 1].date, conf.axis) : ''
    ]
  };
}


/* ---------- 调价周期推算（来自 data/adjust-cycle.js，两端共用同一份实现） ---------- */

var ADJUST_CYCLE = (function () {
/**
 * 调价周期推算：下一轮调价日 / 下次公告发布日
 *
 * 单一真源。小程序端（data/）与服务端（server/src/shared/shared.js，由
 * scripts/sync-shared.js 从本文件生成）共用这一份实现。
 *
 * 为什么需要推算：
 *   - 官方调价时间表（xmgcn-timeline）只给**已发生**的轮次，最新一条到今天为止；
 *   - 预测源（qiyoujiage）在两轮之间会空窗 —— 站点在轮次一过就把区块改成
 *     公布**结果**（实测 2026-11-17 三省页面给的都是 11-12 那轮的下调结果，
 *     isForecast=false），下一轮窗口要等它更新；
 *   - 于是「来源已公布」和「界面要有个下次时间」之间有个空档，
 *     这个空档只能靠调价周期规律推。
 *
 * ⚠️ 推算值不是官方公布值，界面上必须标「推算 · 非官方」。
 *
 * 周期规律（用 2025-11-25 → 2026-11-12 的 23 个真实轮次实测校准）：
 *   官方机制是「10 个工作日一轮」。23 个相邻间隔里 12 个正好是 10 个工作日，
 *   其余偏长的是跨春节/国庆顺延，偏短的是「当轮不调整」占位。
 *   推算口径：最近一次实际调价日 + 10 个工作日，遇法定节假日顺延、
 *   调休上班日算工作日。实测该口径能复现最近连续三轮（10-15→10-29→
 *   10-29→11-12），也复现了跨国庆那一轮（09-24→10-15）。
 *
 * 节假日表来自国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04 发布），
 * 2027 年安排尚未正式公布，只放已确认的元旦与春节。
 */

/**
 * 法定节假日（放假期间整段非工作日）。
 *
 * 每项 [起始日, 结束日] 都是闭区间，日期写 YYYY-MM-DD。
 * 数据来源：国务院办公厅关于 2026 年部分节假日安排的通知。
 */
const HOLIDAYS = [
  ['2026-01-01', '2026-01-03'],   // 元旦
  ['2026-02-15', '2026-02-23'],   // 春节
  ['2026-04-04', '2026-04-06'],   // 清明
  ['2026-05-01', '2026-05-05'],   // 劳动节
  ['2026-06-19', '2026-06-21'],   // 端午
  ['2026-09-25', '2026-09-27'],   // 中秋
  ['2026-10-01', '2026-10-07'],   // 国庆
  ['2027-01-01', '2027-01-03'],   // 2027 元旦
  ['2027-02-05', '2027-02-13']    // 2027 春节（除夕起 9 天）
];

/**
 * 调休上班日（周末但要上班，算工作日）。
 *
 * 数据来源：国务院办公厅关于 2026 年部分节假日安排的通知。
 * 2027 年安排尚未正式公布 —— 调休上班日一律先按「不是工作日」处理，
 * 也就是宁可把推算日推晚一点，也不提前。
 */
const MAKEUP_WORKDAYS = [
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10'
];

/** 调价周期：10 个工作日 */
var WORKDAYS_PER_CYCLE = 10;

/**
 * 解析成 UTC 时间戳。解析不出来返回 null。
 */
function parseDate(dateStr) {
  var m = String(dateStr || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 时间戳 → YYYY-MM-DD
 */
function formatDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 这一天是不是法定节假日（放假期间）。
 */
function isHoliday(dateStr) {
  for (var i = 0; i < HOLIDAYS.length; i++) {
    if (dateStr >= HOLIDAYS[i][0] && dateStr <= HOLIDAYS[i][1]) return true;
  }
  return false;
}

/**
 * 这一天是不是工作日。
 *
 * 规则：周一至周五是工作日；法定节假日不是；调休上班日是。
 */
function isWorkday(dateStr) {
  var ts = parseDate(dateStr);
  if (ts === null) return false;
  var dow = new Date(ts).getUTCDay();
  if (dow === 0 || dow === 6) {
    // 周末：只有调休上班日才算工作日
    for (var i = 0; i < MAKEUP_WORKDAYS.length; i++) {
      if (MAKEUP_WORKDAYS[i] === dateStr) return true;
    }
    return false;
  }
  return !isHoliday(dateStr);
}

/**
 * 从 dateStr 起，往后数 n 个工作日，返回那天的 YYYY-MM-DD。
 *
 * 「往后数」的含义：从 dateStr 的**次日**开始数，dateStr 本身不算在内。
 * 也就是 nextWorkday(date, 1) = date 之后的第一个工作日。
 *
 * @param {string} dateStr 起始日 YYYY-MM-DD
 * @param {number} n       工作日个数
 * @returns {string|null}  YYYY-MM-DD；起始日解析不出来返回 null
 */
function addWorkdays(dateStr, n) {
  var ts = parseDate(dateStr);
  if (ts === null) return null;
  var count = Number(n);
  if (!isFinite(count) || count <= 0) return dateStr;
  var cur = ts;
  var left = Math.floor(count);
  // 上限兜底：10 年，再多说明参数不对，别让调用方把 CPU 跑满
  var guard = 0;
  while (left > 0 && guard < 4000) {
    cur += 86400000;
    guard++;
    if (isWorkday(formatDate(cur))) left--;
  }
  return formatDate(cur);
}

/**
 * 从最近一次实际调价日推算下一轮调价日。
 *
 * @param {string} lastAdjustDate 最近一次实际调价日 YYYY-MM-DD
 * @param {number} [cycle]        周期（工作日数），默认 10
 * @returns {string|null}        推算出的下一轮调价日 YYYY-MM-DD
 */
function estimateNextAdjustDate(lastAdjustDate, cycle) {
  var n = cycle === undefined ? WORKDAYS_PER_CYCLE : Number(cycle);
  if (!isFinite(n) || n <= 0) return null;
  return addWorkdays(lastAdjustDate, n);
}

/**
 * 推算下次公告发布日。
 *
 * ⚠️ 口径：发改委公告在**调价执行当天上午**发布（实测 4 条公告的 PubDate
 * 分别是执行日当天 10:49 / 10:29 / 10:08 / 14:21）。所以「下次公告发布日」
 * 就是下一轮调价日当天 —— 与「下次调价日」同一天，不是提前几天。
 *
 * @param {string} nextAdjustDate 推算出的下一轮调价日 YYYY-MM-DD
 * @returns {string|null}
 */
function estimateNoticeDate(nextAdjustDate) {
  if (!nextAdjustDate) return null;
  return String(nextAdjustDate).slice(0, 10);
}

/**
 * 界面上标注推算口径的一行说明。
 *
 * 单一真源：首页窗口卡、调价页窗口卡都读这一句，别各写一遍。
 */
var ESTIMATE_NOTE = '按 10 个工作日周期推算 · 非官方，以正式公告为准';

/**
 * 「下次通知时间」的说明。
 *
 * ⚠️ 口径来自实测，不是推测：抓发改委「新闻发布」列表页的分页
 * （2025-07 ~ 2026-11 共 6 页），35 条「成品油价格」公告的
 * **发布日与调价执行日全部是同一天**（提前天数分布：提前 0 天 35 条），
 * 发布时刻落在 09:15 ~ 16:59 之间。
 *
 * 所以「下次通知时间」= 下次调价日当天，不是提前几天 ——
 * 公告上午发，油价当晚 24:00 才变。
 */
var NOTICE_TIME_NOTE = '公告一般在调价当天上午至下午发布';

/**
 * 推算结果的完整载荷。
 *
 * @param {string} lastAdjustDate 最近一次实际调价日 YYYY-MM-DD
 * @param {number} [cycle]        周期（工作日数），默认 10
 * @returns {object|null} {
 *   nextAdjustDate:  下一轮调价日 YYYY-MM-DD,
 *   nextNoticeDate:  下次公告发布日 YYYY-MM-DD（与调价日同一天）,
 *   daysLeft:        距今天还有几天,
 *   basedOn:         推算依据（最近一次实际调价日）,
 *   cycleWorkdays:   周期工作日数,
 *   note:            口径说明,
 *   noticeNote:      公告发布时间的口径说明
 * }
 */
function estimateNext(lastAdjustDate, cycle, todayStr) {
  var next = estimateNextAdjustDate(lastAdjustDate, cycle);
  if (!next) return null;
  var out = {
    nextAdjustDate: next,
    nextNoticeDate: estimateNoticeDate(next),
    basedOn: String(lastAdjustDate || '').slice(0, 10),
    cycleWorkdays: cycle === undefined ? WORKDAYS_PER_CYCLE : Number(cycle),
    note: ESTIMATE_NOTE,
    // 下次公告发布日的口径说明（公告当天发，见 NOTICE_TIME_NOTE）
    noticeNote: NOTICE_TIME_NOTE
  };
  var from = parseDate(todayStr);
  var to = parseDate(next);
  if (from !== null && to !== null) {
    out.daysLeft = Math.round((to - from) / 86400000);
  }
  return out;
}


  return {
    HOLIDAYS: HOLIDAYS,
    MAKEUP_WORKDAYS: MAKEUP_WORKDAYS,
    WORKDAYS_PER_CYCLE: WORKDAYS_PER_CYCLE,
    ESTIMATE_NOTE: ESTIMATE_NOTE,
    NOTICE_TIME_NOTE: NOTICE_TIME_NOTE,
    isHoliday: isHoliday,
    isWorkday: isWorkday,
    addWorkdays: addWorkdays,
    estimateNextAdjustDate: estimateNextAdjustDate,
    estimateNoticeDate: estimateNoticeDate,
    estimateNext: estimateNext
  };
})();

/* ---------- 吨价→每升折算（来自 data/ton-conversion.js，两端共用同一份实现） ---------- */

var TON_CONVERSION = (function () {
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


  return {
    FUEL_GROUP: FUEL_GROUP,
    DENSITY: DENSITY,
    LITER_PER_100TON: LITER_PER_100TON,
    CALIBRATION_ROUNDS: CALIBRATION_ROUNDS,
    convertTonToLiter: convertTonToLiter,
    convertTonToLiterAll: convertTonToLiterAll
  };
})();
var DEMO_ANCHOR = "2026-11-10";

var FUELS = [
  {
    "id": "92",
    "name": "92# 汽油",
    "short": "92#",
    "unit": "元/升"
  },
  {
    "id": "95",
    "name": "95# 汽油",
    "short": "95#",
    "unit": "元/升"
  },
  {
    "id": "98",
    "name": "98# 汽油",
    "short": "98#",
    "unit": "元/升"
  },
  {
    "id": "0",
    "name": "0# 柴油",
    "short": "0#",
    "unit": "元/升"
  }
];

var REGIONS = [
  {
    "code": "310000",
    "name": "上海",
    "city": "上海",
    "pinyin": "sh",
    "slugs": {
      "qiyoujiage": "shanghai",
      "xmgcn": "shanghai"
    },
    "offset": {
      "0": -0.01,
      "92": -0.09,
      "95": -0.13,
      "98": 0.62
    }
  },
  {
    "code": "530000",
    "name": "云南",
    "city": "昆明",
    "pinyin": "yn",
    "slugs": {
      "qiyoujiage": "yunnan",
      "xmgcn": "yunnan"
    },
    "offset": {
      "0": 0.07,
      "92": 0.1,
      "95": 0.16,
      "98": -0.41
    }
  },
  {
    "code": "150000",
    "name": "内蒙古",
    "city": "呼和浩特",
    "pinyin": "nmg",
    "slugs": {
      "qiyoujiage": "neimenggu",
      "xmgcn": "namenggu"
    },
    "offset": {
      "0": -0.16,
      "92": -0.05,
      "95": -0.09,
      "98": -0.47
    }
  },
  {
    "code": "110000",
    "name": "北京",
    "city": "北京",
    "pinyin": "bj",
    "slugs": {
      "qiyoujiage": "beijing",
      "xmgcn": "beijing"
    },
    "offset": {
      "0": 0.07,
      "92": -0.05,
      "95": -0.08,
      "98": 0.17
    }
  },
  {
    "code": "220000",
    "name": "吉林",
    "city": "长春",
    "pinyin": "jl",
    "slugs": {
      "qiyoujiage": "jilin",
      "xmgcn": "jilin"
    },
    "offset": {
      "0": -0.08,
      "92": -0.09,
      "95": 0.01,
      "98": -0.39
    }
  },
  {
    "code": "510000",
    "name": "四川",
    "city": "成都",
    "pinyin": "sc",
    "slugs": {
      "qiyoujiage": "sichuan",
      "xmgcn": "sichuan"
    },
    "offset": {
      "0": 0.04,
      "92": 0.04,
      "95": 0.05,
      "98": 0.16
    }
  },
  {
    "code": "120000",
    "name": "天津",
    "city": "天津",
    "pinyin": "tj",
    "slugs": {
      "qiyoujiage": "tianjin",
      "xmgcn": "tianjin"
    },
    "offset": {
      "0": 0.02,
      "92": -0.06,
      "95": -0.15,
      "98": 0.1
    }
  },
  {
    "code": "640000",
    "name": "宁夏",
    "city": "银川",
    "pinyin": "nx",
    "slugs": {
      "qiyoujiage": "ningxia",
      "xmgcn": "ningxia"
    },
    "offset": {
      "0": -0.12,
      "92": -0.16,
      "95": -0.27,
      "98": -0.24
    }
  },
  {
    "code": "340000",
    "name": "安徽",
    "city": "合肥",
    "pinyin": "ah",
    "slugs": {
      "qiyoujiage": "anhui",
      "xmgcn": "anhui"
    },
    "offset": {
      "0": 0.05,
      "92": -0.11,
      "95": -0.11,
      "98": 0.14
    }
  },
  {
    "code": "370000",
    "name": "山东",
    "city": "济南",
    "pinyin": "sd",
    "slugs": {
      "qiyoujiage": "shandong",
      "xmgcn": "shandong"
    },
    "offset": {
      "0": -0.08,
      "92": -0.09,
      "95": -0.05,
      "98": -0.3
    }
  },
  {
    "code": "140000",
    "name": "山西",
    "city": "太原",
    "pinyin": "sx",
    "slugs": {
      "qiyoujiage": "shanxi",
      "xmgcn": "shanxi"
    },
    "offset": {
      "0": 0.09,
      "92": -0.12,
      "95": -0.01,
      "98": -0.08
    }
  },
  {
    "code": "440000",
    "name": "广东",
    "city": "广州",
    "pinyin": "gd",
    "slugs": {
      "qiyoujiage": "guangdong",
      "xmgcn": "guangdong"
    },
    "offset": {
      "0": 0.02,
      "92": -0.03,
      "95": 0.11,
      "98": 0.86
    }
  },
  {
    "code": "450000",
    "name": "广西",
    "city": "南宁",
    "pinyin": "gx",
    "slugs": {
      "qiyoujiage": "guangxi",
      "xmgcn": "guangxi"
    },
    "offset": {
      "0": 0.06,
      "92": 0,
      "95": 0.12,
      "98": 0.15
    }
  },
  {
    "code": "650000",
    "name": "新疆",
    "city": "乌鲁木齐",
    "pinyin": "xj",
    "slugs": {
      "qiyoujiage": "xinjiang",
      "xmgcn": "xinjiang"
    },
    "offset": {
      "0": -0.23,
      "92": -0.25,
      "95": -0.25,
      "98": -0.24
    }
  },
  {
    "code": "320000",
    "name": "江苏",
    "city": "南京",
    "pinyin": "js",
    "slugs": {
      "qiyoujiage": "jiangsu",
      "xmgcn": "jiangsu"
    },
    "offset": {
      "0": -0.03,
      "92": -0.09,
      "95": -0.13,
      "98": 0.69
    }
  },
  {
    "code": "360000",
    "name": "江西",
    "city": "南昌",
    "pinyin": "jx",
    "slugs": {
      "qiyoujiage": "jiangxi",
      "xmgcn": "jiangxi"
    },
    "offset": {
      "0": 0.06,
      "92": -0.1,
      "95": -0.05,
      "98": 0.2
    }
  },
  {
    "code": "130000",
    "name": "河北",
    "city": "石家庄",
    "pinyin": "hb",
    "slugs": {
      "qiyoujiage": "hebei",
      "xmgcn": "hebei"
    },
    "offset": {
      "0": 0.02,
      "92": -0.06,
      "95": -0.15,
      "98": -0.58
    }
  },
  {
    "code": "410000",
    "name": "河南",
    "city": "郑州",
    "pinyin": "hn",
    "slugs": {
      "qiyoujiage": "henan",
      "xmgcn": "henan"
    },
    "offset": {
      "0": 0,
      "92": -0.04,
      "95": -0.04,
      "98": -0.63
    }
  },
  {
    "code": "330000",
    "name": "浙江",
    "city": "杭州",
    "pinyin": "zj",
    "slugs": {
      "qiyoujiage": "zhejiang",
      "xmgcn": "zhejiang"
    },
    "offset": {
      "0": -0.01,
      "92": -0.09,
      "95": -0.12,
      "98": 0.13
    }
  },
  {
    "code": "460000",
    "name": "海南",
    "city": "海口",
    "pinyin": "hi",
    "slugs": {
      "qiyoujiage": "hainan",
      "xmgcn": "hainan"
    },
    "offset": {
      "0": 0.1,
      "92": 1.06,
      "95": 1.09,
      "98": 0.84
    }
  },
  {
    "code": "420000",
    "name": "湖北",
    "city": "武汉",
    "pinyin": "hb",
    "slugs": {
      "qiyoujiage": "hubei",
      "xmgcn": "hubei"
    },
    "offset": {
      "0": 0,
      "92": -0.04,
      "95": -0.01,
      "98": 0.14
    }
  },
  {
    "code": "430000",
    "name": "湖南",
    "city": "长沙",
    "pinyin": "hn",
    "slugs": {
      "qiyoujiage": "hunan",
      "xmgcn": "hunan"
    },
    "offset": {
      "0": 0.08,
      "92": -0.11,
      "95": -0.16,
      "98": -0.21
    }
  },
  {
    "code": "620000",
    "name": "甘肃",
    "city": "兰州",
    "pinyin": "gs",
    "slugs": {
      "qiyoujiage": "gansu",
      "xmgcn": "gansu"
    },
    "offset": {
      "0": -0.1,
      "92": -0.05,
      "95": -0.05,
      "98": -0.73
    }
  },
  {
    "code": "350000",
    "name": "福建",
    "city": "福州",
    "pinyin": "fj",
    "slugs": {
      "qiyoujiage": "fujian",
      "xmgcn": "fujian"
    },
    "offset": {
      "0": 0,
      "92": -0.1,
      "95": -0.1,
      "98": 0.15
    }
  },
  {
    "code": "540000",
    "name": "西藏",
    "city": "拉萨",
    "pinyin": "xz",
    "slugs": {
      "qiyoujiage": "xizang",
      "xmgcn": "xicang"
    },
    "offset": {
      "0": 0.53,
      "92": 0.81,
      "95": 0.78,
      "98": 0.71
    }
  },
  {
    "code": "520000",
    "name": "贵州",
    "city": "贵阳",
    "pinyin": "gz",
    "slugs": {
      "qiyoujiage": "guizhou",
      "xmgcn": "guizhou"
    },
    "offset": {
      "0": 0.11,
      "92": 0.08,
      "95": -0.01,
      "98": -0.26
    }
  },
  {
    "code": "210000",
    "name": "辽宁",
    "city": "沈阳",
    "pinyin": "ln",
    "slugs": {
      "qiyoujiage": "liaoning",
      "xmgcn": "liaoning"
    },
    "offset": {
      "0": -0.1,
      "92": 0.02,
      "95": 0.04,
      "98": -0.29
    }
  },
  {
    "code": "500000",
    "name": "重庆",
    "city": "重庆",
    "pinyin": "cq",
    "slugs": {
      "qiyoujiage": "chongqing",
      "xmgcn": "chongqing"
    },
    "offset": {
      "0": 0.06,
      "92": 0,
      "95": -0.09,
      "98": 0.61
    }
  },
  {
    "code": "610000",
    "name": "陕西",
    "city": "西安",
    "pinyin": "sn",
    "slugs": {
      "qiyoujiage": "shanxi-3",
      "xmgcn": "shanxi2"
    },
    "offset": {
      "0": -0.11,
      "92": -0.18,
      "95": -0.28,
      "98": -0.2
    }
  },
  {
    "code": "630000",
    "name": "青海",
    "city": "西宁",
    "pinyin": "qh",
    "slugs": {
      "qiyoujiage": "qinghai",
      "xmgcn": "qinghai"
    },
    "offset": {
      "0": -0.08,
      "92": -0.09,
      "95": -0.06,
      "98": -0.46
    }
  },
  {
    "code": "230000",
    "name": "黑龙江",
    "city": "哈尔滨",
    "pinyin": "hlj",
    "slugs": {
      "qiyoujiage": "heilongjiang",
      "xmgcn": "heilongjiang"
    },
    "offset": {
      "0": -0.22,
      "92": -0.09,
      "95": -0.06,
      "98": -0.04
    }
  }
];

var DEFAULT_REGION_CODE = "440000";

var ADJUSTMENTS = [
  {
    "date": "2025-11-15",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.1,
      "92": 0.1,
      "95": 0.11,
      "98": 0.12
    }
  },
  {
    "date": "2025-11-28",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.13,
      "92": -0.14,
      "95": -0.15,
      "98": -0.17
    }
  },
  {
    "date": "2025-12-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.05,
      "95": 0.06,
      "98": 0.06
    }
  },
  {
    "date": "2025-12-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.15,
      "92": -0.16,
      "95": -0.17,
      "98": -0.19
    }
  },
  {
    "date": "2026-01-15",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.11,
      "92": 0.12,
      "95": 0.13,
      "98": 0.14
    }
  },
  {
    "date": "2026-01-29",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.09,
      "92": -0.1,
      "95": -0.11,
      "98": -0.12
    }
  },
  {
    "date": "2026-02-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.07,
      "92": 0.08,
      "95": 0.09,
      "98": 0.09
    }
  },
  {
    "date": "2026-02-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.11,
      "92": -0.12,
      "95": -0.13,
      "98": -0.14
    }
  },
  {
    "date": "2026-03-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.06,
      "95": 0.07,
      "98": 0.07
    }
  },
  {
    "date": "2026-03-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.08,
      "92": -0.09,
      "95": -0.1,
      "98": -0.11
    }
  },
  {
    "date": "2026-04-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.1,
      "92": 0.11,
      "95": 0.12,
      "98": 0.13
    }
  },
  {
    "date": "2026-04-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.06,
      "92": -0.07,
      "95": -0.08,
      "98": -0.08
    }
  },
  {
    "date": "2026-05-12",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.05,
      "92": -0.06,
      "95": -0.07,
      "98": -0.07
    }
  },
  {
    "date": "2026-05-26",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.08,
      "92": 0.09,
      "95": 0.1,
      "98": 0.11
    }
  },
  {
    "date": "2026-06-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.12,
      "92": 0.13,
      "95": 0.14,
      "98": 0.15
    }
  },
  {
    "date": "2026-06-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.14,
      "92": -0.15,
      "95": -0.16,
      "98": -0.18
    }
  },
  {
    "date": "2026-07-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.06,
      "92": 0.07,
      "95": 0.08,
      "98": 0.08
    }
  },
  {
    "date": "2026-07-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.07,
      "92": -0.08,
      "95": -0.09,
      "98": -0.1
    }
  },
  {
    "date": "2026-08-12",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.04,
      "92": -0.05,
      "95": -0.06,
      "98": -0.06
    }
  },
  {
    "date": "2026-08-26",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.09,
      "92": 0.1,
      "95": 0.11,
      "98": 0.12
    }
  },
  {
    "date": "2026-09-07",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.04,
      "92": 0.04,
      "95": 0.05,
      "98": 0.05
    }
  },
  {
    "date": "2026-09-28",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.09,
      "92": -0.1,
      "95": -0.11,
      "98": -0.12
    }
  },
  {
    "date": "2026-10-20",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.06,
      "95": 0.07,
      "98": 0.07
    }
  },
  {
    "date": "2026-11-02",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.08,
      "92": -0.08,
      "95": -0.09,
      "98": -0.1
    }
  }
];

var NATIONAL_BASE = {
  "0": 8.75,
  "92": 9.13,
  "95": 9.73,
  "98": 11.04
};

/* ---------- 演示时钟：与小程序端 utils/demo-clock.js 同一套规则 ---------- */

function parseUtc(dateStr) {
  var m = String(dateStr).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function localDayNumber(date) {
  // 与小程序端 utils/demo-clock.js 一致：统一按 UTC+8 日历日算，
  // 否则客户端在东八区、服务器在 UTC 时，凌晨会差一天。
  var t = new Date(date.getTime() + 8 * 3600000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

function offsetDays() {
  var anchor = parseUtc(DEMO_ANCHOR);
  if (anchor === null) return 0;
  return Math.round((localDayNumber(new Date()) - anchor) / 86400000);
}

function shiftDate(dateStr) {
  if (!dateStr) return '';
  var base = parseUtc(dateStr);
  if (base === null) return dateStr;
  var d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays());
  return d.toISOString().slice(0, 10);
}

function today() {
  return shiftDate(DEMO_ANCHOR);
}

function daysUntil(dateStr) {
  var target = parseUtc(dateStr);
  if (target === null) return 0;
  var todayTs = parseUtc(today());
  return Math.round((target - todayTs) / 86400000);
}

/* ---------- 价格计算 ---------- */

function round2(v) {
  return Math.round(v * 100) / 100;
}

function regionByCode(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i].code === code) return REGIONS[i];
  }
  return REGIONS[0];
}

/**
 * 查地区，查不到返回 null。
 *
 * ⚠️ regionByCode 找不到会静默回退上海（REGIONS[0]），
 * 传 ?regionCode=999999 时页面显示「上海 · 上海」但查不到价格，
 * 返回的是自相矛盾的数据。需要区分「没传」和「传错了」的地方一律用这个。
 */
function findRegion(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i].code === code) return REGIONS[i];
  }
  return null;
}

var LEVEL_CACHE = {};

function levels(fuelId) {
  if (LEVEL_CACHE[fuelId]) return LEVEL_CACHE[fuelId];
  var price = NATIONAL_BASE[fuelId];
  var list = [{ date: null, price: price, delta: 0, title: null }];
  ADJUSTMENTS.forEach(function (item) {
    price = round2(price + item.deltas[fuelId]);
    list.push({
      // 日期统一平移，和小程序端保持同一时间基准
      date: shiftDate(item.date),
      price: price,
      delta: item.deltas[fuelId],
      title: item.title
    });
  });
  LEVEL_CACHE[fuelId] = list;
  return list;
}

function nationalPriceOn(fuelId, dateStr) {
  var list = levels(fuelId);
  var price = list[0].price;
  for (var i = 1; i < list.length; i++) {
    if (list[i].date <= dateStr) price = list[i].price;
    else break;
  }
  return price;
}

function priceOn(regionCode, fuelId, dateStr) {
  var region = regionByCode(regionCode);
  // 地区价差按油品分别取：各省标号结构不同，共用一套 offset 误差太大
  var offset = (region.offset && region.offset[fuelId] !== undefined) ? region.offset[fuelId] : 0;
  return round2(nationalPriceOn(fuelId, dateStr) + offset);
}

function currentPrice(regionCode, fuelId) {
  return priceOn(regionCode, fuelId, today());
}

function allPrices() {
  var out = [];
  REGIONS.forEach(function (region) {
    FUELS.forEach(function (fuel) {
      var list = levels(fuel.id);
      out.push({
        regionCode: region.code,
        regionName: region.name + ' · ' + region.city,
        fuelId: fuel.id,
        fuelName: fuel.name,
        price: currentPrice(region.code, fuel.id),
        changeAmount: list[list.length - 1].delta,
        changeAt: list[list.length - 1].date
      });
    });
  });
  return out;
}

function dedupKey(sourceId, title, executeAt) {
  return [sourceId, String(executeAt || '').slice(0, 10), String(title || '').replace(/\s+/g, '')].join('::');
}

module.exports = {
  DEMO_ANCHOR: DEMO_ANCHOR,
  FUELS: FUELS,
  REGIONS: REGIONS,
  DEFAULT_REGION_CODE: DEFAULT_REGION_CODE,
  ADJUSTMENTS: ADJUSTMENTS,
  NATIONAL_BASE: NATIONAL_BASE,
  round2: round2,
  regionByCode: regionByCode,
  findRegion: findRegion,
  levels: levels,
  nationalPriceOn: nationalPriceOn,
  priceOn: priceOn,
  currentPrice: currentPrice,
  allPrices: allPrices,
  dedupKey: dedupKey,
  MARKETS: MARKETS,
  buildSeries: buildSeries,
  MARKET_PERIODS: MARKET_PERIODS,
  marketAxisLabel: marketAxisLabel,
  ADJUST_CYCLE: ADJUST_CYCLE,
  TON_CONVERSION: TON_CONVERSION,
  buildMarketPayload: buildMarketPayload,
  clock: { today: today, shiftDate: shiftDate, daysUntil: daysUntil, offsetDays: offsetDays }
};