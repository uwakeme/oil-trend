/**
 * 订阅消息模板契约
 *
 * ⚠️ 这里是微信公众平台「订阅消息 → 我的模板 → 模板详情」的**镜像**。
 *
 * 平台的硬规则（踩过就回不来）：
 *   1. data 的 key 必须**严格等于**模板占位符名
 *      （当前模板：thing5 / amount2 / amount6 / phrase1 / date3）。
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
 *
 * ⚠️ 「调整幅度」字段有两种形态，差别很大：
 *   amount 类型 —— 只能放「数字+元」，装不下区间，也不该拿 0 冒充「幅度未知」；
 *   thing/phrase 类型 —— 能放整句（比如「每升下调0.52元」「幅度待公布」）。
 *   官方公告只给吨价、每升幅度还拿不到时，只有文本类型的模板才发得了提醒，
 *   这种模板在下面登记成**方向模板**（服务端 .env 的
 *   OIL_SUBSCRIBE_DIRECTION_TEMPLATE_ID 指向它）。
 *
 * ⚠️ 有些模板**没有「温馨提示」字段**（当前在用的就是：
 *   第 6 个关键词换成了「实时油价」）。地区与口径说明没地方放时，
 *   只能并进唯一装得下整句的文本字段「油品种类」（≤20 字符），
 *   装不下就按重要性取舍 —— 口径说明丢不得（见 compose）。
 */

/**
 * 模板表：key 是模板 ID
 *
 * 当前模板：
 *   油价调整提醒（编号 1103，信息查询）
 *   一次性订阅消息 —— 用户每次授权只够发一条，发完要重新授权
 */
var TEMPLATES = {
  // 当前在用：带「实时油价」的版本。
  // ⚠️ 这个模板**没有「温馨提示」字段** —— 地区与口径说明只能并进
  //    「油品种类」（thing 类型，20 字符，可含汉字数字符号）。
  'OaHgjTXIhVAUOtdvqE_yxVbqLaHLbFN5MJS3lNFQVt0': {
    name: '油价调整提醒',
    kind: 'once',
    fields: {
      thing5: { type: 'thing', role: 'fuel', label: '油品种类', max: 20 },
      phrase1: { type: 'phrase', role: 'direction', label: '调整方向', max: 5 },
      amount2: { type: 'amount', role: 'amount', label: '调整价格', max: 10 },
      amount6: { type: 'amount', role: 'price', label: '实时油价', max: 10 },
      date3: { type: 'date', role: 'date', label: '调整日期' }
    }
  },
  // 旧版本：带「温馨提示」，口径说明有地方写，但现价只能挤在提示里。
  'OaHgjTXIhVAUOtdvqE_yxWZkt8r0cZdbhwuD4kq9Rqg': {
    name: '油价调整提醒（带温馨提示）',
    kind: 'once',
    fields: {
      thing5: { type: 'thing', role: 'fuel', label: '油品种类', max: 20 },
      amount2: { type: 'amount', role: 'amount', label: '调整价格', max: 10 },
      phrase1: { type: 'phrase', role: 'direction', label: '调整方向', max: 5 },
      date3: { type: 'date', role: 'date', label: '调整日期' },
      thing4: { type: 'thing', role: 'tip', label: '温馨提示', max: 20 }
    }
  }
};

/** 当前在用的模板 ID（与服务端 .env 的 OIL_SUBSCRIBE_TEMPLATE_ID 一致） */
var PRIMARY_TEMPLATE_ID = 'OaHgjTXIhVAUOtdvqE_yxVbqLaHLbFN5MJS3lNFQVt0';

/** 取模板定义；模板 ID 没登记过就返回 null */
function templateOf(templateId) {
  return TEMPLATES[templateId] || null;
}

/**
 * 登记一个模板。
 *
 * ⚠️ 生产上平台模板的契约仍以本文件里的镜像为准：
 *    平台换了模板，这里必须同步改，否则字段对不上，消息发不出去。
 *    这个函数给「模板还没申请下来时先把链路跑通」用（自检就是）。
 */
function registerTemplate(templateId, spec) {
  if (!templateId || !spec) return null;
  TEMPLATES[templateId] = spec;
  return TEMPLATES[templateId];
}

/**
 * 模板里有没有某个角色。
 *
 * ⚠️ 不同模板的字段数与角色不一定一样：
 *    主模板有独立的「调整方向」字段，方向模板不一定有 ——
 *    没有的话，方向要写进「调整幅度」那一句里。
 */
function hasRole(templateId, role) {
  return !!fieldOfRole(templateId, role);
}

/**
 * 模板里某个角色的字段定义（没有就 null）。
 */
function fieldOfRole(templateId, role) {
  var tpl = templateOf(templateId);
  if (!tpl) return null;
  var found = null;
  Object.keys(tpl.fields).forEach(function (key) {
    if (!found && tpl.fields[key].role === role) found = tpl.fields[key];
  });
  return found;
}

/**
 * 这个角色的字段能不能装整句文本。
 *
 * ⚠️ amount（数字）类型只认「数字+元」，
 *    装不下「每升下调0.52元」「幅度待公布」这种整句。
 */
function roleCarriesText(templateId, role) {
  var field = fieldOfRole(templateId, role);
  return !!(field && field.type !== 'amount');
}

/**
 * 组一条消息的字段值。
 *
 * ⚠️ 平台要求**每个字段都有值**，漏一个就被拒收（47003）；
 *    所以模板装不下的内容只能并进某个装得下整句的文本字段。
 *
 * 分工规则：
 *   - 幅度：字段能装文本 → 装字段；只能装数字 → 装数值（区间/未知由 extra 补）；
 *   - 当前价格：模板有「当前价格」字段 → 装字段；没有 → 并进提示；
 *   - 附加内容（地区 + 额外说明 + 口径说明）：
 *       模板有「温馨提示」字段 → 装那个字段；
 *       没有 → 并进「油品种类」（当前模板唯一的文本字段，≤20 字符）。
 *     超长时从最不重要的开始丢，**口径说明必须保留**
 *     （测算值、预测值不标口径就是误导）。
 *
 * @param {string} templateId
 * @param {object} content {
 *   fuel, amountNumber, amountText, direction, date,
 *   priceNumber, priceText, region, scope, extra
 * }
 */
function compose(templateId, content) {
  var c = content || {};
  var amountText = '';
  var amountToTip = '';
  var amountNumber = c.amountNumber;
  if (!fieldOfRole(templateId, 'amount')) {
    // 模板没有幅度字段 → 幅度整句只能并进附加内容
    amountToTip = textOrEmpty(c.amountText);
  } else if (roleCarriesText(templateId, 'amount')) {
    // 字段能装整句 → 整句进字段
    amountText = textOrEmpty(c.amountText);
  }
  var priceText = '';
  var priceNumber = c.priceNumber;
  if (fieldOfRole(templateId, 'price')) {
    if (roleCarriesText(templateId, 'price')) {
      priceText = textOrEmpty(c.priceText);
    }
  } else {
    // 模板没有当前价格字段 → 并进附加内容
    priceText = textOrEmpty(c.priceText);
  }

  // 附加内容的片段：口径说明必留，其余按重要性取舍 ——
  // 放不下时按 rank 从低到高丢：现价 → 地区 → 额外说明 → 幅度整句。
  var parts = [];
  if (c.region) parts.push({ text: c.region, rank: 2 });
  if (amountToTip) parts.push({ text: amountToTip, rank: 4 });
  // 幅度整句已经在附加内容里（或已经在字段里）时，额外的区间说明不重复
  if (c.extra && !amountToTip && !amountText) parts.push({ text: c.extra, rank: 3 });
  if (priceText) parts.push({ text: priceText, rank: 1 });

  var scope = c.scope || '';
  var tipField = fieldOfRole(templateId, 'tip');
  var fuel = c.fuel || '';
  var tip = '';
  var packed;

  if (tipField) {
    packed = packText('', parts, scope, tipField.max || 20);
    tip = packed.text;
  } else {
    // ⚠️ 模板没有「温馨提示」字段（当前在用的模板就是这种：
    //    第 6 个关键词是「实时油价」，把「温馨提示」换掉了）——
    //    地区与口径说明只能并进「油品种类」那个装得下整句的文本字段。
    var carrier = carrierOf(templateId);
    if (carrier) {
      packed = packText(fuel, parts, scope, carrier.field.max || 20);
      fuel = packed.text;
    } else {
      // 既没有提示字段，也没有能承载的文本字段 → 保不住
      packed = {
        text: '',
        dropped: parts.map(function (p) { return p.text; }).concat(scope ? [scope] : [])
      };
    }
  }

  if (packed.dropped.length) {
    // 丢了内容不能闷声不响：模板装不下是产品侧的约束，得看得见
    console.warn('[subscribe] 模板 ' + templateId + ' 装不下，已丢弃: ' + packed.dropped.join(' / '));
  }

  return dataByRole(templateId, {
    fuel: fuel,
    amount: amountNumber,
    amountText: amountText,
    direction: c.direction,
    date: c.date,
    price: priceNumber,
    priceText: priceText,
    tip: tip
  });
}

/**
 * 空值转空串（组装阶段先统一成字符串，格式化交给各类型的格式化函数）。
 */
function textOrEmpty(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 没有「温馨提示」字段时，附加内容往哪儿放。
 *
 * ⚠️ 当前在用的模板把「温馨提示」换成了「实时油价」——
 *    只剩「油品种类」（thing 类型，20 字符）装得下整句，
 *    地区、口径说明、区间全挤在这一行里。
 *
 * 返回 { key, field }，找不到就返回 null。
 */
function carrierOf(templateId) {
  var tpl = templateOf(templateId);
  if (!tpl) return null;
  var found = null;
  Object.keys(tpl.fields).forEach(function (key) {
    var f = tpl.fields[key];
    if (!found && f.role === 'fuel' && f.type !== 'amount') found = { key: key, field: f };
  });
  return found;
}

/**
 * 把「固定内容 + 可丢片段 + 口径说明」拼进一个限长字段。
 *
 * ⚠️ 口径说明（实测/测算/非官方）**丢不得** ——
 *    测算值、预测值不标口径就是误导。
 *    放不下时按 rank 从低到高丢片段（rank 小的先丢）。
 *
 * @param {string} prefix 固定内容（如油品名），最后才动它
 * @param {Array} parts [{ text, rank }]
 * @param {string} scope 口径说明，必留
 * @param {number} limit 字段长度上限
 * @returns {{ text: string, dropped: string[] }}
 */
function packText(prefix, parts, scope, limit) {
  var list = [];
  (parts || []).forEach(function (p) {
    if (p && p.text) list.push({ text: String(p.text), rank: p.rank });
  });
  var dropped = [];
  var scopeText = scope || '';
  var max = limit || 20;
  while (true) {
    var ordered = [];
    if (prefix) ordered.push(prefix);
    list.forEach(function (p) { ordered.push(p.text); });
    if (scopeText) ordered.push(scopeText);
    var text = ordered.join('·');
    if (text.length <= max) return { text: text, dropped: dropped };
    if (!list.length) {
      // 只剩「固定内容 + 口径」还放不下 → 砍固定内容，口径说明留着
      var room = max - (scopeText ? scopeText.length + 1 : 0);
      if (prefix && room > 0) {
        return {
          text: prefix.slice(0, room) + (scopeText ? '·' + scopeText : ''),
          dropped: dropped
        };
      }
      return { text: scopeText ? scopeText.slice(0, max) : '', dropped: dropped };
    }
    // 找出 rank 最小的（最不重要的）丢掉
    var worst = 0;
    list.forEach(function (p, i) {
      if (p.rank < list[worst].rank) worst = i;
    });
    dropped.push(list[worst].text);
    list.splice(worst, 1);
  }
}

/**
 * 按「角色」填模板字段。
 *
 * ⚠️ thing5 / amount2 / phrase1 这些只是**平台占位符的名字**，
 * 换个模板就换成别的名字 —— 以前 buildData 直接写死它们，
 * 换模板必错位（字段名对不上，平台一律 47003）。
 * 现在字段的**角色**写在契约表里，这里按角色取值：
 * 换模板只改契约表，不改业务代码。
 *
 * @param {string} templateId
 * @param {object} values { fuel, amount, amountText, direction, date, tip }
 * @returns {object} { 字段名: 格式化后的值 }
 */
function dataByRole(templateId, values) {
  var tpl = templateOf(templateId);
  var out = {};
  if (!tpl) return out;
  var v = values || {};
  Object.keys(tpl.fields).forEach(function (key) {
    var field = tpl.fields[key];
    out[key] = formatByType(field.type, valueOfRole(field.role, field.type, v));
  });
  return out;
}

/** 角色 → 具体取值（角色决定取哪个值，类型决定怎么格式化） */
function valueOfRole(role, type, values) {
  var v = values || {};
  switch (role) {
    case 'fuel':
      return v.fuel;
    case 'direction':
      return v.direction;
    case 'date':
      return v.date;
    case 'tip':
      return v.tip;
    case 'price':
      // 当前价格：数字型字段放数值，文本型字段放「现价8.39元」
      if (type === 'amount') return v.price;
      if (v.priceText !== undefined && v.priceText !== null) return v.priceText;
      return v.price;
    case 'amount':
      // amount 类型的字段只认「数字+元」；
      // 文本类型的字段能放整句（比如「每升下调0.52元」「幅度待公布」）
      if (type === 'amount') return v.amount;
      if (v.amountText !== undefined && v.amountText !== null) return v.amountText;
      return v.amount;
    default:
      return undefined;
  }
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

/* ---------------- 微信请求体格式 ---------------- */

/**
 * 转成微信订阅消息要求的 data 格式。
 *
 * ⚠️ 微信的 message/subscribe/send 要求每个字段是**对象**：
 *      { "thing5": { "value": "92# 汽油" } }
 *    传扁平字符串（{ "thing5": "92# 汽油" }）平台一律拒收，errcode 47003。
 *    —— 这条踩过：契约表与校验都是按扁平值写的，两边「一致地」漏了包装，
 *    自检全绿但真发必失败。
 *
 * 包装放在契约表里，因为「字段名 + 值格式 + 包装方式」是同一份平台契约。
 * 幂等：已经是 { value: ... } 的原样保留。
 */
function toWeChatData(values) {
  var out = {};
  Object.keys(values || {}).forEach(function (key) {
    var v = values[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
      out[key] = { value: String(v.value) };
      return;
    }
    out[key] = { value: String(v === undefined || v === null ? '' : v) };
  });
  return out;
}

/**
 * 校验**最终请求体**里的 data（已经是 { value: ... } 结构）。
 *
 * 解包后按同一套契约校验 —— 包装错了也要能发现，
 * 不能只校验扁平值就以为请求体是对的。
 */
function validateWeChat(templateId, data) {
  var flat = {};
  Object.keys(data || {}).forEach(function (key) {
    var v = data[key];
    flat[key] = (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v;
  });
  var res = validate(templateId, flat);
  if (!res.ok) return res;
  var errors = [];
  Object.keys(data || {}).forEach(function (key) {
    var v = data[key];
    if (!v || typeof v !== 'object' || Array.isArray(v) || !('value' in v)) {
      errors.push('NOT_WRAPPED:' + key);
      return;
    }
    if (typeof v.value !== 'string') errors.push('VALUE_NOT_STRING:' + key);
  });
  return { ok: errors.length === 0, errors: errors };
}

module.exports = {
  TEMPLATES: TEMPLATES,
  PRIMARY_TEMPLATE_ID: PRIMARY_TEMPLATE_ID,
  templateOf: templateOf,
  registerTemplate: registerTemplate,
  hasRole: hasRole,
  fieldOfRole: fieldOfRole,
  roleCarriesText: roleCarriesText,
  carrierOf: carrierOf,
  compose: compose,
  dataByRole: dataByRole,
  toWeChatData: toWeChatData,
  validateWeChat: validateWeChat,
  formatAmount: formatAmount,
  formatDate: formatDate,
  formatPhrase: formatPhrase,
  formatThing: formatThing,
  formatByType: formatByType,
  validate: validate
};
