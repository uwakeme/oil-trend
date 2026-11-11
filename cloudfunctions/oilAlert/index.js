/**
 * 油势 · 降价提醒匹配与订阅消息下发云函数
 *
 * 触发方式：定时触发器（默认每 10 分钟）
 *
 * 匹配优先级（与设计文档一致）：
 *   1. 官方正式降价 —— 可信度最高，默认开启
 *   2. 达到用户目标价 —— 按地区 + 油品匹配
 *   3. 预测下调 —— 默认关闭，需用户主动开启
 *
 * 关键约束：
 *   1. 只能在用户主动订阅授权的前提下下发，规则里没有订阅记录就跳过；
 *   2. 同一个「规则 + 事件」只发一次，用 alert_logs 的 dedupKey 保证；
 *   3. 下发失败要落库，不能静默丢弃。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const C = {
  rules: 'alert_rules',
  logs: 'alert_logs',
  prices: 'oil_prices',
  notices: 'oil_notices'
};

/**
 * 订阅消息模板字段映射
 *
 * ⚠️ 这里必须与「微信公众平台 → 订阅消息 → 模板详情」里的字段一一对应。
 * 下面是常见配置（thing=事物、time=时间、amount=金额、phrase=短语），
 * 申请模板后请按实际字段名调整。
 */
const TEMPLATE_FIELDS = {
  officialDrop: {
    // 模板 ID 从环境变量读，不再在代码里手填一处、
    // config/index.js 再手填一处，漏一处就静默失败。
    templateId: process.env.OIL_SUBSCRIBE_TEMPLATE_ID || '',
    page: 'pages/index/index',
    fields: {
      thing1: '油品',
      thing2: '地区',
      amount3: '降价幅度',
      time4: '执行时间'
    }
  },
  targetPrice: {
    templateId: process.env.OIL_SUBSCRIBE_TEMPLATE_ID || '',
    page: 'pages/index/index',
    fields: {
      thing1: '油品',
      thing2: '地区',
      amount3: '当前价格',
      thing4: '目标价格'
    }
  }
};

function nowIso() {
  return new Date().toISOString();
}

function fuelName(id) {
  return { '92': '92# 汽油', '95': '95# 汽油', '98': '98# 汽油', '0': '0# 柴油' }[id] || id + '#';
}

/** 是否已经发过同一个事件 */
async function alreadySent(dedupKey) {
  var res = await db.collection(C.logs).where({ dedupKey: dedupKey }).get();
  return !!(res.data && res.data.length);
}

async function writeLog(doc) {
  await db.collection(C.logs).add({ data: Object.assign({ time: nowIso() }, doc) });
}

/**
 * 下发一条订阅消息
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
async function sendSubscribe(openid, templateId, page, fields, templateData) {
  if (!templateId) {
    return { sent: false, reason: 'TEMPLATE_NOT_CONFIGURED' };
  }
  // 模板字段映射必须覆盖要发的数据，漏字段直接报配置错误，
  // 而不是把消息发出去后被平台拒掉。
  var keys = Object.keys(templateData || {});
  for (var i = 0; i < keys.length; i++) {
    if (!fields || !fields[keys[i]]) {
      return { sent: false, reason: 'TEMPLATE_FIELD_MISMATCH:' + keys[i] };
    }
  }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: templateId,
      page: page,
      data: templateData,
      // 开发版/体验版联调要能切成对应状态
      miniprogramState: process.env.OIL_MINIPROGRAM_STATE || 'formal'
    });
    return { sent: true };
  } catch (err) {
    console.error('[oilAlert] send failed', err);
    return { sent: false, reason: (err && err.errMsg) || String(err) };
  }
}

/**
 * 匹配单条规则
 */
async function matchRule(rule, prices, latestNotice, forecastNotice) {
  var hits = [];

  var priceDoc = null;
  prices.forEach(function (p) {
    if (p.regionCode === rule.regionCode && p.fuelId === rule.fuelId) priceDoc = p;
  });
  if (!priceDoc) return hits;

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
        data: {
          thing1: fuelName(rule.fuelId),
          thing2: rule.regionName || rule.regionCode,
          amount3: Math.abs(delta).toFixed(2) + ' 元/升',
          time4: latestNotice.executeAt || ''
        }
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
        data: {
          thing1: fuelName(rule.fuelId),
          thing2: rule.regionName || rule.regionCode,
          amount3: priceDoc.price.toFixed(2) + ' 元/升',
          thing4: rule.targetPrice.toFixed(2) + ' 元/升'
        }
      });
    }
  }

  /* --- 3. 预测下调（默认关闭） --- */
  if (rule.forecastDrop && forecastNotice) {
    if (forecastNotice) {
      var fDelta = (forecastNotice.changes || {})[rule.fuelId];
      if (typeof fDelta === 'number' && fDelta < 0) {
        hits.push({
          type: 'forecastDrop',
          dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'forecast', forecastNotice.executeAt].join('::'),
          title: '预测下调（非官方）',
          price: priceDoc.price,
          template: TEMPLATE_FIELDS.officialDrop,
          data: {
            thing1: fuelName(rule.fuelId),
            thing2: rule.regionName || rule.regionCode,
            amount3: Math.abs(fDelta).toFixed(2) + ' 元/升',
            time4: forecastNotice.executeAt || ''
          }
        });
      }
    }
  }

  return hits;
}

async function getAllRules() {
  var all = [];
  var skip = 0;
  var PAGE = 100;
  while (true) {
    var res = await db.collection(C.rules).skip(skip).limit(PAGE).get();
    var batch = res.data || [];
    all = all.concat(batch);
    if (batch.length < PAGE) break;
    skip += PAGE;
    if (skip > 10000) break;
  }
  return all;
}

exports.main = async () => {
  var summary = { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  try {
    // 规则集合要分页取全，否则超过单次上限后，后面的用户收不到提醒
    var rules = await getAllRules();
    var pricesRes = await db.collection(C.prices).get();
    var prices = pricesRes.data || [];

    var noticeRes = await db.collection(C.notices)
      .where({ kind: 'official' })
      .orderBy('executeAt', 'desc')
      .limit(1)
      .get();
    var latestNotice = (noticeRes.data && noticeRes.data[0]) || null;

    // 预测通知所有规则共用，查一次就够
    var forecastRes = await db.collection(C.notices).where({ kind: 'forecast' }).orderBy('executeAt', 'desc').limit(1).get();
    var forecastNotice = (forecastRes.data && forecastRes.data[0]) || null;

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      summary.checked++;

      // 没授权订阅就不发
      if (!rule.subscribeGranted) {
        summary.skipped++;
        continue;
      }

      var hits = await matchRule(rule, prices, latestNotice, forecastNotice);
      for (var j = 0; j < hits.length; j++) {
        var hit = hits[j];
        if (await alreadySent(hit.dedupKey)) {
          summary.skipped++;
          continue;
        }
        summary.matched++;

        var result = await sendSubscribe(
          rule.userId,
          rule.templateId || hit.template.templateId,
          hit.template.page,
          hit.template.fields,
          hit.data
        );

        await writeLog({
          userId: rule.userId,
          ruleId: rule._id,
          dedupKey: hit.dedupKey,
          type: hit.type,
          title: hit.title,
          channel: result.sent ? '订阅消息' : '未发送',
          price: String(hit.price),
          priceText: Number(hit.price).toFixed(2),
          sent: result.sent,
          failReason: result.reason || ''
        });

        if (result.sent) summary.sent++;
        else summary.failed++;

        summary.details.push({
          ruleId: rule._id,
          type: hit.type,
          sent: result.sent,
          reason: result.reason || ''
        });
      }
    }

    return { ok: true, data: summary };
  } catch (err) {
    console.error('[oilAlert] failed', err);
    return { ok: false, message: (err && err.errMsg) || String(err), code: 'INTERNAL_ERROR' };
  }
};
