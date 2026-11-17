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

module.exports = {
  HOLIDAYS: HOLIDAYS,
  MAKEUP_WORKDAYS: MAKEUP_WORKDAYS,
  WORKDAYS_PER_CYCLE: WORKDAYS_PER_CYCLE,
  ESTIMATE_NOTE: ESTIMATE_NOTE,
  NOTICE_TIME_NOTE: NOTICE_TIME_NOTE,
  parseDate: parseDate,
  formatDate: formatDate,
  isHoliday: isHoliday,
  isWorkday: isWorkday,
  addWorkdays: addWorkdays,
  estimateNextAdjustDate: estimateNextAdjustDate,
  estimateNoticeDate: estimateNoticeDate,
  estimateNext: estimateNext
};
