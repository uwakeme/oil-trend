/**
 * 演示数据集时钟
 *
 * 演示数据里的日期是写死的，如果原样展示，用一周后打开就全是过期日期。
 * 这里把整套数据按「今天 - 锚点日」整体平移，保证演示数据永远新鲜，
 * 同时保持内部时间线（调价先后、窗口天数）完全自洽。
 */
const config = require('../config/index');

var ANCHOR = config.demoAnchorDate || '2026-11-10';

function parseUtc(dateStr) {
  var m = String(dateStr).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 把某个时刻换算成「本地日历日」的 UTC 零点。
 * 用 UTC+8 算和用 UTC+13 算，结果都应该是同一个日历日差，
 * 不能拿本地零点去减 UTC 零点（那会随时区偏一天）。
 */
function localDayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 相对锚点的天数偏移（今天为 0） */
function offsetDays() {
  var anchor = parseUtc(ANCHOR);
  if (anchor === null) return 0;
  return Math.round((localDayNumber(new Date()) - anchor) / 86400000);
}

/** 平移一个 YYYY-MM-DD 日期 */
function shiftDate(dateStr) {
  if (!dateStr) return '';
  var base = parseUtc(dateStr);
  if (base === null) return dateStr;
  var d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays());
  return d.toISOString().slice(0, 10);
}

/** 平移一个带时间戳的字符串，保留时间部分 */
function shiftDateTime(value) {
  if (!value) return '';
  var s = String(value);
  if (s.length < 10) return s;
  return shiftDate(s.slice(0, 10)) + s.slice(10);
}

/** 今天的 YYYY-MM-DD */
function today() {
  return shiftDate(ANCHOR);
}

/** 今天的显示时间（数据更新时间固定为 08:30） */
function todayUpdatedAt() {
  return today() + 'T08:30:00+08:00';
}

/** 距离某日期还有几天（正数=未来） */
function daysUntil(dateStr) {
  var target = parseUtc(dateStr);
  if (target === null) return 0;
  var todayTs = parseUtc(today());
  return Math.round((target - todayTs) / 86400000);
}

/** 往前推 n 个月，返回 YYYY-MM-DD */
function monthsAgo(n, from) {
  var base = parseUtc(from || today());
  if (base === null) base = parseUtc(today());
  var d = new Date(base);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** 往前推 n 天 */
function daysAgo(n, from) {
  var base = parseUtc(from || today());
  if (base === null) base = parseUtc(today());
  var d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  ANCHOR: ANCHOR,
  offsetDays: offsetDays,
  shiftDate: shiftDate,
  shiftDateTime: shiftDateTime,
  today: today,
  todayUpdatedAt: todayUpdatedAt,
  daysUntil: daysUntil,
  monthsAgo: monthsAgo,
  daysAgo: daysAgo
};
