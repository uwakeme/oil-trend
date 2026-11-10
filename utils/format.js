/** 通用格式化工具 */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 价格：两位小数 */
function price(value) {
  var num = Number(value);
  if (!isFinite(num)) return '--';
  return num.toFixed(2);
}

/** 带符号的金额：+0.06 / -0.08 / 0.00 */
function signed(value, digits) {
  var num = Number(value);
  if (!isFinite(num)) return '--';
  var text = num.toFixed(digits === undefined ? 2 : digits);
  if (num > 0) return '+' + text;
  return text;
}

/** 百分比：-2.13% */
function percent(value) {
  var num = Number(value);
  if (!isFinite(num)) return '--';
  return (num > 0 ? '+' : '') + num.toFixed(2) + '%';
}

/** 2026-11-02 → 11/02 */
function shortDate(dateStr) {
  if (!dateStr) return '';
  var parts = String(dateStr).slice(0, 10).split('-');
  if (parts.length !== 3) return dateStr;
  return parts[1] + '/' + parts[2];
}

/** 2026-11-02 → 11月02日 */
function cnDate(dateStr) {
  if (!dateStr) return '';
  var parts = String(dateStr).slice(0, 10).split('-');
  if (parts.length !== 3) return dateStr;
  return parts[1] + '月' + parts[2] + '日';
}

/** 2026-11-02T18:00:00+08:00 → 2026-11-02 */
function dateOnly(value) {
  return value ? String(value).slice(0, 10) : '';
}

/** 2026-11-02T18:00:00+08:00 → 11-02 18:00 */
function dateTime(value) {
  if (!value) return '';
  var s = String(value);
  var d = s.slice(0, 10).split('-');
  var t = s.slice(11, 16);
  if (d.length !== 3) return s;
  return d[1] + '-' + d[2] + ' ' + t;
}

/** 2026-11-02 → 2026 年 11 月 2 日 */
function fullDate(dateStr) {
  if (!dateStr) return '';
  var parts = String(dateStr).slice(0, 10).split('-');
  if (parts.length !== 3) return dateStr;
  return parts[0] + ' 年 ' + Number(parts[1]) + ' 月 ' + Number(parts[2]) + ' 日';
}

/** 倒计时文案 */
function countdown(daysLeft) {
  var n = Number(daysLeft);
  if (!isFinite(n)) return '--';
  if (n > 0) return '还有 ' + n + ' 天';
  if (n === 0) return '就是今天';
  return '已过 ' + Math.abs(n) + ' 天';
}

module.exports = {
  pad2: pad2,
  price: price,
  signed: signed,
  percent: percent,
  shortDate: shortDate,
  cnDate: cnDate,
  dateOnly: dateOnly,
  dateTime: dateTime,
  fullDate: fullDate,
  countdown: countdown
};
