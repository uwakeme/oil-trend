/**
 * 提醒匹配与订阅消息下发
 *
 * 逻辑与早期云函数实现一致（云函数已下线，见 git 历史），
 * 订阅消息走微信官方 HTTP 接口，数据访问走 DAO。
 *
 * 匹配优先级（与设计文档一致）：
 *   1. 官方正式降价 —— 可信度最高，默认开启
 *   2. 达到用户目标价 —— 按地区 + 油品匹配
 *   3. 预测下调 —— 默认关闭，需用户主动开启
 *
 * ⚠️ 订阅消息是**一次性**授权：用户每次点同意只够发一条。
 * 所以命中多条也只发第一条，发成功后把这条规则的订阅额度用掉，
 * 用户要再收必须重新授权（提醒页会如实显示「授权已用完」）。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const subscribe = require('./subscribe');
const templates = require('./subscribe-templates');

/**
 * 模板字段映射
 *
 * ⚠️ 字段名必须与「微信公众平台 → 订阅消息 → 模板详情」里的占位符**一字不差**，
 * 自己起名（thing1、price…）平台一律拒收（errcode 47003）。
 *
 * 当前模板「油价调整提醒」（编号 1103，信息查询）只有 5 个字段：
 *   thing5  油品种类  thing  （≤20 字符）
 *   amount2 调整价格  amount （≤10 字符，形如 "0.13元"）
 *   phrase1 调整方向  phrase （≤5 字符）
 *   date3   调整日期  date   （"2026年11月24日"）
 *   thing4  温馨提示  thing  （≤20 字符）
 *
 * 模板里**没有**「地区」「当前价」「目标价」字段，
 * 地区与当前价只能塞进「温馨提示」。
 *
 * 字段名的唯一真源是 subscribe-templates.js（平台模板的镜像），
 * 这里不再另写一份，换模板只改契约表。
 */
function templateFieldsOf(templateId) {
  var tpl = templates.templateOf(templateId);
  if (!tpl) return null;
  var fields = {};
  Object.keys(tpl.fields).forEach(function (key) {
    fields[key] = tpl.fields[key].label;
  });
  return fields;
}

var REMINDER_FIELDS = templateFieldsOf(templates.PRIMARY_TEMPLATE_ID);

/** 三种提醒共用同一个模板：字段语义一样，只是填的值不同 */
var TEMPLATE_FIELDS = {
  officialDrop: { page: 'pages/index/index', fields: REMINDER_FIELDS },
  targetPrice: { page: 'pages/index/index', fields: REMINDER_FIELDS },
  forecastDrop: { page: 'pages/index/index', fields: REMINDER_FIELDS }
};

function fuelName(id) {
  return { '92': '92# 汽油', '95': '95# 汽油', '98': '98# 汽油', '0': '0# 柴油' }[id] || id + '#';
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 地区名。
 *
 * ⚠️ alert_rules 表里**没有** region_name 列，rule.regionName 永远是 undefined，
 * 以前写 rule.regionName || rule.regionCode 拿到的是 '440000' 这种代码。
 * 而且 shared.regionByCode 找不到时会静默回退上海 —— 这里自己查，
 * 查不到就退回原始代码，不能张冠李戴。
 */
function regionNameOf(regionCode) {
  var list = shared.REGIONS || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].code === regionCode) return list[i].name;
  }
  return regionCode || '';
}

/**
 * 服务器「今天」（按 UTC+8 日历日）。
 *
 * ⚠️ 不能用 shared.clock.today()：那是**演示数据**的平移日期，
 * 线上真实场景拿来当今天会算错日期。
 */
function todayCN() {
  var t = new Date(Date.now() + 8 * 3600000);
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}

/**
 * 组装一条订阅消息的 data。
 *
 * 值一律走 subscribe-templates.js 的格式化函数：
 *   amount2 只能给「数字+元」，"0.13 元/升" 会被平台判格式非法；
 *   date3   只能给中文年月日，"2026-11-24" 解析不了；
 *   phrase1 最多 5 个字符，thing 最多 20 个字符。
 */
function buildData(opts) {
  return {
    thing5: templates.formatThing(opts.fuel),
    amount2: templates.formatAmount(opts.amount),
    phrase1: templates.formatPhrase(opts.direction),
    date3: templates.formatDate(opts.date),
    thing4: templates.formatThing(opts.tip)
  };
}

/**
 * 下发一条订阅消息
 *
 * 发之前先按模板契约自检：字段名对不上、值格式不合法，
 * 平台会直接拒收（47003 / 47002），报错还很难看出是哪一项。
 * 自己先拦下来，日志里才有可读的原因。
 */
function sendSubscribe(openid, template, templateData) {
  var templateId = subscribe.templateId();
  if (!templateId) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_NOT_CONFIGURED' });
  }
  // 模板 ID 没登记在契约表里 → 不知道该填哪几个字段，硬发只会被拒
  if (!templates.templateOf(templateId)) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_NOT_REGISTERED:' + templateId });
  }
  var check = templates.validate(templateId, templateData);
  if (!check.ok) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_DATA_INVALID:' + check.errors.join(',') });
  }
  return subscribe.send({
    openid: openid,
    templateId: templateId,
    page: template.page,
    data: templateData
  });
}

/**
 * 匹配单条规则
 */
function matchRule(rule, prices, latestNotice, forecastNotice) {
  var hits = [];

  var priceDoc = null;
  prices.forEach(function (p) {
    if (p.regionCode === rule.regionCode && p.fuelId === rule.fuelId) priceDoc = p;
  });
  if (!priceDoc) return hits;

  var regionName = regionNameOf(rule.regionCode);
  var currentText = Number(priceDoc.price).toFixed(2);

  /* --- 1. 官方正式降价 --- */
  if (rule.officialDrop && latestNotice && latestNotice.kind === 'official') {
    var delta = (latestNotice.changes || {})[rule.fuelId];
    if (typeof delta === 'number' && delta < 0) {
      hits.push({
        type: 'officialDrop',
        dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'official', latestNotice.executeAt].join('::'),
        title: rule.fuelId + '# ' + fuelName(rule.fuelId) + ' 官方降价',
        price: priceDoc.price,
        template: TEMPLATE_FIELDS.officialDrop,
        data: buildData({
          fuel: fuelName(rule.fuelId),
          amount: Math.abs(delta),
          direction: '下调',
          date: latestNotice.executeAt,
          // 模板没有「地区」字段，地区和当前价只能写进温馨提示
          tip: regionName + '现价' + currentText + '元'
        })
      });
    }
  }

  /* --- 2. 目标价 --- */
  if (rule.targetEnabled && typeof rule.targetPrice === 'number') {
    if (priceDoc.price <= rule.targetPrice) {
      hits.push({
        type: 'targetPrice',
        dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'target', rule.targetPrice].join('::'),
        title: '已达目标价 ' + rule.targetPrice.toFixed(2),
        price: priceDoc.price,
        template: TEMPLATE_FIELDS.targetPrice,
        data: buildData({
          fuel: fuelName(rule.fuelId),
          // 「调整价格」在目标价场景填目标价，方向填「已达目标」
          amount: rule.targetPrice,
          direction: '已达目标',
          date: todayCN(),
          tip: regionName + '现价' + currentText + '元'
        })
      });
    }
  }

  /* --- 3. 预测下调（默认关闭） --- */
  if (rule.forecastDrop && forecastNotice) {
    var fDelta = (forecastNotice.changes || {})[rule.fuelId];
    if (typeof fDelta === 'number' && fDelta < 0) {
      hits.push({
        type: 'forecastDrop',
        dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'forecast', forecastNotice.executeAt].join('::'),
        title: '预测下调（非官方）',
        price: priceDoc.price,
        template: TEMPLATE_FIELDS.forecastDrop,
        data: buildData({
          fuel: fuelName(rule.fuelId),
          amount: Math.abs(fDelta),
          direction: '预计下调',
          date: forecastNotice.executeAt,
          tip: regionName + '预测仅供参考，以官方为准'
        })
      });
    }
  }

  return hits;
}

/**
 * 失败分类：可重试 / 不可重试。
 *
 * 可重试 —— 网络抖动、平台限流（45009）、access_token 失效（40001/40014）：
 *   下一轮重来就行，占位必须释放，否则这个事件被永久锁死。
 * 不可重试 —— 模板没配 / 数据不合契约 / 用户没有订阅额度（43101）：
 *   再发多少次都一样，占位留着当失败凭据，额度一并用掉。
 */
function classifyFailure(reason) {
  var s = String(reason || '');
  if (!s) return 'retryable';
  // 平台侧配置/参数问题：TEMPLATE_NOT_CONFIGURED / TEMPLATE_DATA_INVALID …
  if (/^TEMPLATE_/.test(s)) return 'permanent';
  var m = s.match(/^(\d{4,5}):/);
  if (m) {
    var code = m[1];
    // 43101 无订阅额度、47002/47003 值或模板非法、40003 openid 非法
    if (code === '43101' || code === '47002' || code === '47003' || code === '40003') return 'permanent';
    return 'retryable';
  }
  // 没有错误码的（网络异常、请求超时等）都能再试
  return 'retryable';
}

/**
 * 按顺序找第一条没发过的事件发出去。
 *
 * ⚠️ 一次性订阅的授权额度只有 1 条：命中多条也只发第一条，
 * 发完这条规则的额度就没了。
 */
function sendFirstHit(rule, hits, summary) {
  var index = 0;

  function step() {
    if (index >= hits.length) {
      summary.skipped++;
      return Promise.resolve(null);
    }
    var hit = hits[index++];
    // ⚠️ 去重要**前置**：先占住去重键，占到的人才有资格发消息。
    // 原来是「查有没有发过 → 发 → 落库」，去重发生在副作用之后：
    // 两个实例同时跑时两边都查不到，都会发一遍，用户收到两条。
    return dao.logs.reserve({
      userId: rule.userId,
      dedupKey: hit.dedupKey,
      payload: { type: hit.type, title: hit.title, price: hit.price, data: hit.data }
    }).then(function (reserved) {
      // 占不到 = 这个键已经被人处理过了，换下一条
      if (!reserved) return step();
      summary.matched++;
      return sendSubscribe(rule.userId, hit.template, hit.data).then(function (result) {
        if (result.sent) {
          return dao.logs.markResult(reserved.id, true, null).then(function () {
            summary.details.push({
              userId: rule.userId,
              type: hit.type,
              sent: true,
              reason: ''
            });
            summary.sent++;
            // 一次性订阅：额度用掉，用户要再收必须重新授权
            return dao.rules.consumeSubscribe(rule).then(function () { return null; });
          });
        }
        // 失败：分「可重试」和「不可重试」两种处理
        var reason = result.reason || 'UNKNOWN';
        summary.details.push({
          userId: rule.userId,
          type: hit.type,
          sent: false,
          reason: reason
        });
        summary.failed++;
        if (classifyFailure(reason) === 'retryable') {
          // 把占位释放掉：这一轮没发成，下一轮还能重试。
          // ⚠️ 之前不管成没成都把占位行留着 —— 网络抖动一次，
          // 这个事件的 dedupKey 就被永久占住，再也发不出第二次。
          return dao.logs.release(reserved.id).then(function () { return null; });
        }
        // 不可重试：留着失败记录当凭据，并把额度用掉（再发也是白发）
        return dao.logs.markResult(reserved.id, false, reason).then(function () {
          return dao.rules.consumeSubscribe(rule).then(function () { return null; });
        });
      });
    });
  }

  return step();
}

function run() {
  var summary = { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  return Promise.all([
    dao.rules.listAll(1000, 0),
    dao.prices.listAll(),
    dao.notices.latestByKind('official'),
    dao.notices.latestByKind('forecast')
  ]).then(function (r0) {
    var rules = r0[0];
    var prices = r0[1];
    var latestNotice = r0[2];
    var forecastNotice = r0[3];

    return rules.reduce(function (chain, rule) {
      return chain.then(function () {
        summary.checked++;

        // 没授权订阅就不发
        if (!rule.subscribeGranted) {
          summary.skipped++;
          return null;
        }

        var hits = matchRule(rule, prices, latestNotice, forecastNotice);
        if (!hits.length) return null;

        return sendFirstHit(rule, hits, summary);
      });
    }, Promise.resolve());
  }).then(function () {
    return summary;
  });
}

module.exports = {
  run: run,
  matchRule: matchRule,
  buildData: buildData,
  // 导出给自检用：失败分类决定占位放不放，两边必须一致
  classifyFailure: classifyFailure,
  regionNameOf: regionNameOf,
  todayCN: todayCN,
  TEMPLATE_FIELDS: TEMPLATE_FIELDS
};
