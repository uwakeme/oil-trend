/**
 * 订阅消息模板契约
 *
 * ⚠️ 这里是微信公众平台「订阅消息 → 我的模板 → 模板详情」的**镜像**。
 *
 * 平台的硬规则（踩过就回不来）：
 *   1. data 的 key 必须**严格等于**模板占位符名（thing5 / amount2 / phrase1 / date3 / thing4）。
 *      自己起名（thing1、price…）一律被拒，errcode 47003。
 *   2. value 要符合字段类型：
 *      thing  —— 纯文本，最多 20 字符
 *      amount —— 数字，最多 10 字符，可带「元」（"0.13元"），不能带其它单位
 *      phrase —— 短语，最多 5 字符
 *      date   —— "2026年11月24日" 或 "2026年11月24日 24:00"，不是 ISO 短日期
 *   3. 模板里每个字段都要给值，漏一个也会被拒。
 *
 * 换模板时只改这里，并同步改：
 *   小程序端 config/index.js 的 subscribeTemplateIds
 *   服务端 .env 的 OIL_SUBSCRIBE_TEMPLATE_ID
 */

/**
 * 模板表：key 是模板 ID
 *
 * 当前模板：
 *   油价调整提醒（编号 1103，信息查询）
 *   一次性订阅消息 —— 用户每次授权只够发一条，发完要重新授权
 */
var TEMPLATES = {
  'OaHgjTXlhVAUOtdvqE_yxWZkt8r0cZdbhwuD4kq9Rqg': {
    name: '油价调整提醒',
    kind: 'once',
    fields: {
      thing5: { type: 'thing', label: '油品种类', max: 20 },
      amount2: { type: 'amount', label: '调整价格', max: 10 },
      phrase1: { type: 'phrase', label: '调整方向', max: 5 },
      date3: { type: 'date', label: '调整日期' },
      thing4: { type: 'thing', label: '温馨提示', max: 20 }
    }
  }
};

/** 当前在用的模板 ID（与服务端 .env 的 OIL_SUBSCRIBE_TEMPLATE_ID 一致） */
var PRIMARY_TEMPLATE_ID = 'OaHgjTXlhVAUOtdvqE_yxWZkt8r0cZdbhwuD4kq9Rqg';

/** 取模板定义；模板 ID 没登记过就返回 null */
function templateOf(templateId) {
  return TEMPLATES[templateId] || null;
}

/* ---------------- 值格式化 ---------------- */

/**
 * 金额：微信只认「数字 + 可选元」。
 * "0.13 元/升" 这种带斜杠的写法会被拒。
 */
function formatAmount(value) {
  // ⚠️ Number(null) 是 0 —— 不先挡掉空值，「幅度缺失」会变成 "0.00元"，
  // 看起来像「幅度为零」而不是「没有幅度」。
  if (value === undefined || value === null || value === '') return null;
  var n = Number(value);
  if (!isFinite(n)) return null;
  return Math.abs(n).toFixed(2) + '元';
}

/**
 * 日期：微信的 date 类型要中文年月日，不能直接给 "2026-11-24"。
 */
function formatDate(value) {
  var m = String(value || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
}

/** 短语：最多 5 字符 */
function formatPhrase(value) {
  var s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return null;
  return s.length > 5 ? s.slice(0, 5) : s;
}

/** 文本：最多 20 字符 */
function formatThing(value) {
  var s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return null;
  return s.length > 20 ? s.slice(0, 20) : s;
}

/** 按字段类型格式化 */
function formatByType(type, value) {
  if (type === 'amount') return formatAmount(value);
  if (type === 'date') return formatDate(value);
  if (type === 'phrase') return formatPhrase(value);
  return formatThing(value);
}

/* ---------------- 校验 ---------------- */

var AMOUNT_RE = /^\d+(\.\d{1,2})?元?$/;
var DATE_RE = /^\d{4}年\d{1,2}月\d{1,2}日( \d{1,2}:\d{2}(:\d{2})?)?$/;

/**
 * 校验一份 data 是否满足模板契约。
 *
 * 返回 { ok, errors }。errors 里每条都指明具体问题，
 * 便于排查时直接看出是「字段名错了」还是「值格式不对」。
 */
function validate(templateId, data) {
  var tpl = templateOf(templateId);
  if (!tpl) {
    return { ok: false, errors: ['UNKNOWN_TEMPLATE:' + templateId] };
  }
  var errors = [];
  var keys = Object.keys(data || {});

  keys.forEach(function (key) {
    var field = tpl.fields[key];
    if (!field) {
      errors.push('UNKNOWN_FIELD:' + key);
      return;
    }
    var value = data[key];
    if (value === undefined || value === null || value === '') {
      errors.push('EMPTY:' + key);
      return;
    }
    var text = String(value);
    if (field.max && text.length > field.max) {
      errors.push('TOO_LONG:' + key + '(' + text.length + '>' + field.max + ')');
      return;
    }
    if (field.type === 'amount' && !AMOUNT_RE.test(text)) {
      errors.push('BAD_AMOUNT:' + key + '=' + text);
      return;
    }
    if (field.type === 'date' && !DATE_RE.test(text)) {
      errors.push('BAD_DATE:' + key + '=' + text);
    }
  });

  // 模板里有的字段必须都填上，漏一个平台也会拒收
  Object.keys(tpl.fields).forEach(function (key) {
    if (!data || data[key] === undefined || data[key] === null || data[key] === '') {
      errors.push('MISSING:' + key);
    }
  });

  return { ok: errors.length === 0, errors: errors };
}

module.exports = {
  TEMPLATES: TEMPLATES,
  PRIMARY_TEMPLATE_ID: PRIMARY_TEMPLATE_ID,
  templateOf: templateOf,
  formatAmount: formatAmount,
  formatDate: formatDate,
  formatPhrase: formatPhrase,
  formatThing: formatThing,
  formatByType: formatByType,
  validate: validate
};
