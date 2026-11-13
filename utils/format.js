/** 通用格式化工具 */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 空值判定。
 *
 * ⚠️ 不能靠 `Number(value)` 判断：Number(null) === 0、Number('') === 0，
 * 于是「后端没给价格」会被当成「价格是 0.00」显示出去 ——
 * 0.00 元/升 是真实价格，'--' 才是没有数据，两者不能混。
 */
function isBlank(value) {
  return value === null || value === undefined || value === '';
}

/** 价格：两位小数。没有数据统一显示 '--'，不冒充 0.00 */
function price(value) {
  if (isBlank(value)) return '--';
  var num = Number(value);
  if (!isFinite(num)) return '--';
  return num.toFixed(2);
}

/**
 * 价格数值：空值返回 null（区别于 0）。
 *
 * 给「还要继续算数」的调用点用 —— 拿 '--' 去 Number() 会得到 NaN，
 * 拿 0 去比较又会误判成「价格是 0」。这里把两种情况分开。
 */
function priceValue(value) {
  if (isBlank(value)) return null;
  var num = Number(value);
  return isFinite(num) ? num : null;
}

/** 带符号的金额：+0.06 / -0.08 / 0.00 */
function signed(value, digits) {
  if (isBlank(value)) return '--';
  var num = Number(value);
  if (!isFinite(num)) return '--';
  var text = num.toFixed(digits === undefined ? 2 : digits);
  if (num > 0) return '+' + text;
  return text;
}

/** 百分比：-2.13% */
function percent(value) {
  if (isBlank(value)) return '--';
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

/**
 * 采集同步状态 → 展示文案与样式。
 *
 * 单一真源：后端和演示端都可能新增状态，
 * 这里漏了映射，前端就会掉进「其他」分支显示成「同步异常」。
 */
var SYNC_STATUS_META = {
  ok:      { text: '自动同步正常',       style: '' },
  idle:    { text: '真实数据源尚未接入', style: 'muted' },
  pending: { text: '等待人工核对',       style: 'warn' },
  partial: { text: '部分来源采集失败',   style: 'warn' },
  error:   { text: '采集出错',           style: 'error' }
};

/** 同步状态的展示信息；未知状态给中性文案，不要报异常 */
function syncStatus(status) {
  return SYNC_STATUS_META[status] || { text: '同步状态未知', style: 'muted' };
}

/** 倒计时文案 */
function countdown(daysLeft) {
  var n = Number(daysLeft);
  if (!isFinite(n)) return '--';
  if (n > 0) return '还有 ' + n + ' 天';
  if (n === 0) return '就是今天';
  return '已过 ' + Math.abs(n) + ' 天';
}

/**
 * 来源提示条文案。
 *
 * ⚠️ 统一由 source 驱动，不要在 WXML 里硬写「数据由服务端定时采集」——
 * 后端挂了回落演示数据时，硬写的那句话会变成骗人的话。
 *
 * @param {object} source 后端/演示源给的 source 对象
 * @param {string} extra  页面自己的补充说明（如「采集正常」）
 * @returns {{text:string, warn:boolean}}
 */
function sourceLine(source, extra) {
  var src = source || {};
  // 后端挂了 → 回落演示数据，必须明确说出来
  if (src.fellBack) {
    return { text: src.reason || '后端连接失败，当前显示演示数据', warn: true };
  }
  if (src.mode === 'demo') {
    return { text: '演示数据 · 非实时行情', warn: false };
  }
  var text = src.name ? ('数据来自' + src.name) : '数据来自服务端';
  if (extra) text = text + ' · ' + extra;
  return { text: text, warn: false };
}

module.exports = {
  pad2: pad2,
  price: price,
  priceValue: priceValue,
  isBlank: isBlank,
  signed: signed,
  percent: percent,
  shortDate: shortDate,
  cnDate: cnDate,
  dateOnly: dateOnly,
  dateTime: dateTime,
  fullDate: fullDate,
  countdown: countdown,
  syncStatus: syncStatus,
  sourceLine: sourceLine,
  SYNC_STATUS_META: SYNC_STATUS_META
};
