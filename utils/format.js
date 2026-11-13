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
 *
 * 'demo' 不是后端给的状态，而是「这次拿到的是演示数据」时的兜底：
 * 演示数据下写「自动同步正常」是误导 —— 用户看到的根本不是采集来的结果。
 */
var SYNC_STATUS_META = {
  ok:      { text: '自动同步正常',       style: '' },
  idle:    { text: '真实数据源尚未接入', style: 'muted' },
  pending: { text: '等待人工核对',       style: 'warn' },
  partial: { text: '部分来源采集失败',   style: 'warn' },
  error:   { text: '采集出错',           style: 'error' },
  demo:    { text: '演示数据 · 真实公告源尚未接入', style: 'muted' }
};

/**
 * 同步状态的展示信息；未知状态给中性文案，不要报异常。
 *
 * @param {string} status 后端给的同步状态（payload.sync.status）
 * @param {object} source 这次数据的来源（payload.source）
 *   演示数据下不能报「自动同步正常」—— 那是在替来源吹牛。
 *   但真出错 / 部分失败 / 待核对还是要照实说。
 */
function syncStatus(status, source) {
  var src = source || {};
  var meta = SYNC_STATUS_META[status] || null;
  if (src.mode === 'demo') {
    if (status === 'error') return SYNC_STATUS_META.error;
    if (status === 'partial') return SYNC_STATUS_META.partial;
    if (status === 'pending') return SYNC_STATUS_META.pending;
    return SYNC_STATUS_META.demo;
  }
  return meta || { text: '同步状态未知', style: 'muted' };
}

/**
 * 调价窗口是否已过期。
 *
 * daysLeft < 0 = 来源还没公布下一轮，库里留着的是上一轮。
 * 这时不能写「下一次调价窗口」，也不该把失效的预测挂在下面。
 */
function windowExpired(daysLeft) {
  var n = Number(daysLeft);
  return isFinite(n) && n < 0;
}

/**
 * 调价窗口标题（首页与调价页共用一套规则，别各写一遍）。
 */
function windowTitle(daysLeft) {
  return windowExpired(daysLeft) ? '上一轮调价窗口' : '下一次调价窗口';
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
 * 来源 mode 白名单 → 固定文案。
 *
 * 只认两种：
 *   'demo' → 演示数据文案
 *   'live' → 真实数据文案
 * 其余 mode 一律走中性文案「数据来源待确认」。
 *
 * ⚠️ 不要把 source.name 铺到用户面前：那是内部来源名。
 * 五页都用它当主文案会出现同一句话重复，而且可能互相矛盾
 * （首页说「来自服务端」，调价页说「来自采集器」）。
 */
var SOURCE_MODE_TEXT = {
  demo: '演示数据 · 非实时行情',
  live: '真实数据 · 服务端定时采集'
};

/**
 * 来源提示条文案。
 *
 * ⚠️ 统一由 source 驱动，不要在 WXML 里硬写「数据由服务端定时采集」——
 * 后端挂了回落演示数据时，硬写的那句话会变成骗人的话。
 *
 * @param {object} source 后端/演示源给的 source 对象
 * @param {string} extra  页面自己的补充说明（如「目标价以此为基准」）
 * @returns {{text:string, warn:boolean}}
 */
function sourceLine(source, extra) {
  var src = source || {};
  // 后端挂了 → 回落演示数据，必须明确说出来
  if (src.fellBack) {
    return { text: src.reason || '后端连接失败，当前显示演示数据', warn: true };
  }
  var text = SOURCE_MODE_TEXT[src.mode] || '数据来源待确认';
  if (extra) text = text + ' · ' + extra;
  return { text: text, warn: false };
}

/**
 * 「当前数据源」那一行用：按 mode 给一句人话，不暴露内部来源名。
 */
function sourceName(source) {
  var src = source || {};
  if (src.mode === 'demo') return '演示数据集';
  if (src.mode === 'live') return '服务端采集数据';
  return '待确认';
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
  windowExpired: windowExpired,
  windowTitle: windowTitle,
  syncStatus: syncStatus,
  sourceLine: sourceLine,
  sourceName: sourceName,
  SOURCE_MODE_TEXT: SOURCE_MODE_TEXT,
  SYNC_STATUS_META: SYNC_STATUS_META
};
