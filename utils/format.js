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
 * 两个日期之间差几天（按 UTC 日历日算）。
 */
function dayDiff(fromDate, toDate) {
  var a = Date.parse(String(fromDate || '').slice(0, 10) + 'T00:00:00Z');
  var b = Date.parse(String(toDate || '').slice(0, 10) + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * 调价窗口卡的展示文案（首页与调价页共用一套规则，别各写一遍）。
 *
 * ⚠️ 三条规则，缺一条界面就会自相矛盾：
 *   1. 来源已公布下一轮 → 主日期用来源日期，副说明写「预计时间 · 以官方公告为准」；
 *   2. 来源还没公布（库里留着上一轮，daysLeft < 0）→ 主日期改用**推算值**，
 *      并且必须标「推算 · 非官方」—— 绝不把猜测值当官方结果摆出去；
 *   3. 「下次通知」= 下一轮调价公告的发布日。
 *      实测 35 条发改委公告，发布日与调价执行日**全部是同一天**，
 *      所以它与下一轮调价日同一天，差别只在时刻：
 *      公告上午发，油价当晚 24:00 才变。
 *
 * @param {object} win 后端/演示源给的窗口对象
 * @returns {object} 页面直接可用的展示字段
 */
function windowMeta(win) {
  var w = win || {};
  var est = w.estimate || null;
  var hasEstimate = !!(est && est.nextAdjustDate);
  var srcDaysLeft = Number(w.daysLeft);
  if (!isFinite(srcDaysLeft)) srcDaysLeft = 0;
  var expired = windowExpired(srcDaysLeft);
  // 来源根本没给窗口（库里一条窗口记录都没有）时，主日期也只能来自推算值 ——
  // 标「推算 · 非官方」，不能装作是来源公布的。
  var noSource = !w.date;
  // 来源过期（或压根没有）且有推算 → 用推算值当主日期；
  // 否则一律用来源日期（来源优先）
  var useEstimate = hasEstimate && (expired || noSource);

  var dateStr = useEstimate ? est.nextAdjustDate : (w.date || '');
  var daysLeft = useEstimate ? (Number(est.daysLeft) || 0) : srcDaysLeft;
  // 「下次通知」只在能确定「下一轮」时才给：
  //   来源已公布下一轮 → 就是那一轮（公告在调价当天发布）；
  //   来源过期且有推算 → 推算出来的那一轮；
  //   来源过期又没有推算依据 → 下一轮是哪天根本不知道，宁可不给，
  //   拿过期窗口的日期冒充「下次通知」是错的。
  var noticeDate = '';
  if (useEstimate) noticeDate = est.nextNoticeDate || dateStr;
  else if (!expired) noticeDate = dateStr;
  var time = w.time || '24:00';

  // 周期进度：
  //   主日期是来源窗口时，用来源自己的 cycleStart；
  //   主日期换成推算值时，进度必须按「上一轮调价日 → 推算的下一轮」重算 ——
  //   否则进度条还是上一轮的，跟卡片上的日期对不上（一条满格，
  //   底下写着「还有 6 天」）。
  var progress = w.progress === undefined ? 0 : w.progress;
  var cycleStarted = !!w.cycleStarted;
  if (useEstimate && est.basedOn && est.nextAdjustDate) {
    var total = dayDiff(est.basedOn, est.nextAdjustDate);
    if (total > 0) {
      var elapsed = total - (Number(est.daysLeft) || 0);
      progress = Math.min(100, Math.max(0, Math.round(elapsed / total * 100)));
      cycleStarted = elapsed > 0;
    }
  }

  return {
    hasDate: !!dateStr,
    dateStr: dateStr,
    // 首页用带时刻的写法，调价页把时刻拆开单列
    dateText: dateStr ? (cnDate(dateStr) + ' ' + time) : '',
    dateOnlyText: cnDate(dateStr),
    time: time,
    daysLeft: daysLeft,
    passedDays: Math.abs(daysLeft),
    expired: expired,
    // 主日期是不是推算值 —— 界面上要标出来，不能让人当官方值看
    estimated: useEstimate,
    titleText: useEstimate ? '预计下次调价窗口' : windowTitle(srcDaysLeft),
    // 日期下面那行小字
    dateNote: useEstimate ? (est.note || '') : '预计时间 · 以官方公告为准',
    countdownText: (expired && !useEstimate)
      ? ('已过 ' + Math.abs(srcDaysLeft) + ' 天 · 等待下一轮公布')
      : countdown(daysLeft),
    // 「下次通知」那一行
    noticeText: noticeDate ? ('预计 ' + cnDate(noticeDate) + ' 发布公告') : '',
    noticeNote: (est && est.noticeNote) ? est.noticeNote : '',
    progress: progress,
    cycleStarted: cycleStarted
  };
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


/**
 * 调价方向的中文说法。
 */
function directionText(direction) {
  if (direction === 'up') return '上调';
  if (direction === 'down') return '下调';
  if (direction === 'flat') return '不作调整';
  return '';
}

/**
 * 官方公告给出的信息（方向 + 汽/柴油吨价）。
 *
 * 发改委公告只给吨价、只分汽/柴油两类，不给四油品每升幅度 ——
 * 所以这里只说官方真说过的话，不掺任何测算值。
 *
 * 「官方公告：下调 · 汽油 645 元/吨、柴油 625 元/吨」
 */
function noticeOfficialText(notice) {
  if (!notice) return '';
  var dir = directionText(notice.direction || '');
  if (!dir) return '';
  if (notice.direction === 'flat') return '官方公告：本轮不作调整';
  var ton = notice.tonChanges || {};
  var parts = [];
  if (typeof ton.gasoline === 'number') parts.push('汽油 ' + Math.abs(ton.gasoline) + ' 元/吨');
  if (typeof ton.diesel === 'number') parts.push('柴油 ' + Math.abs(ton.diesel) + ' 元/吨');
  if (!parts.length) return '';
  return '官方公告：' + dir + ' · ' + parts.join('、');
}

/**
 * 测算值的口径说明。
 *
 * 官方给的是「标准品（89 号汽油 / 0 号车用柴油）最高零售价」，单位元/吨；
 * 每升幅度是拿各地挂牌价的前后快照差值算出来的 —— 两者口径不同，
 * 摆在一起必须说清楚，否则用户会以为官方值和测算值对不上。
 *
 * 四处展示（首页卡片、首页详情、调价列表、调价详情）都读这一个值。
 */
var MEASURED_NOTE = '官方为标准品最高零售价（元/吨）；每升幅度取各省挂牌价前后快照差值的中位数';

/**
 * 每升四油品幅度取哪一份。
 *
 * 官方公布了每升幅度就用官方的；官方没公布（发改委公告不给这一项）
 * 才用挂牌价测算值，并把 measured 标出来 —— 界面必须写清这是测算值。
 *
 * 返回 { deltas: { '92': -0.13, ... }, measured: 布尔 }
 */
function noticeDeltas(notice) {
  if (!notice) return { deltas: {}, measured: false };
  var official = notice.changes || {};
  if (Object.keys(official).length) return { deltas: official, measured: false };
  var measured = notice.measuredChanges || {};
  if (Object.keys(measured).length) return { deltas: measured, measured: true };
  return { deltas: {}, measured: false };
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
  dayDiff: dayDiff,
  windowExpired: windowExpired,
  windowTitle: windowTitle,
  windowMeta: windowMeta,
  syncStatus: syncStatus,
  sourceLine: sourceLine,
  sourceName: sourceName,
  directionText: directionText,
  noticeOfficialText: noticeOfficialText,
  noticeDeltas: noticeDeltas,
  MEASURED_NOTE: MEASURED_NOTE,
  SOURCE_MODE_TEXT: SOURCE_MODE_TEXT,
  SYNC_STATUS_META: SYNC_STATUS_META
};
