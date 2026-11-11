/**
 * 提醒匹配与订阅消息下发
 *
 * 业务逻辑从 cloudfunctions/oilAlert/index.js 原样搬过来，
 * 只把「cloud.openapi.subscribeMessage.send」换成自己的 HTTP 下发，
 * 把「云数据库查询」换成 DAO。
 *
 * 匹配优先级（与设计文档一致）：
 *   1. 官方正式降价 —— 可信度最高，默认开启
 *   2. 达到用户目标价 —— 按地区 + 油品匹配
 *   3. 预测下调 —— 默认关闭，需用户主动开启
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const subscribe = require('./subscribe');

/**
 * 订阅消息模板字段映射
 *
 * ⚠️ 这里必须与「微信公众平台 → 订阅消息 → 模板详情」里的字段一一对应。
 * 下面是常见配置（thing=事物、time=时间、amount=金额、phrase=短语），
 * 申请模板后请按实际字段名调整。
 */
var TEMPLATE_FIELDS = {
  officialDrop: {
    page: 'pages/index/index',
    fields: {
      thing1: '油品',
      thing2: '地区',
      amount3: '降价幅度',
      time4: '执行时间'
    }
  },
  targetPrice: {
    page: 'pages/index/index',
    fields: {
      thing1: '油品',
      thing2: '地区',
      amount3: '当前价格',
      thing4: '目标价格'
    }
  }
};

function fuelName(id) {
  return { '92': '92# 汽油', '95': '95# 汽油', '98': '98# 汽油', '0': '0# 柴油' }[id] || id + '#';
}

/** 是否已经发过同一个事件 */
function alreadySent(dedupKey) {
  return dao.logs.findByDedupKey(dedupKey).then(function (doc) {
    return !!doc;
  });
}

/**
 * 下发一条订阅消息
 */
function sendSubscribe(openid, template, templateData) {
  // 模板字段映射必须覆盖要发的数据，漏字段直接报配置错误，
  // 而不是把消息发出去后被平台拒掉。
  var keys = Object.keys(templateData || {});
  for (var i = 0; i < keys.length; i++) {
    if (!template.fields || !template.fields[keys[i]]) {
      return Promise.resolve({ sent: false, reason: 'TEMPLATE_FIELD_MISMATCH:' + keys[i] });
    }
  }
  return subscribe.send({
    openid: openid,
    templateId: subscribe.templateId ? subscribe.templateId() : '',
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

  return hits;
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

        return hits.reduce(function (c2, hit) {
          return c2.then(function () {
            return alreadySent(hit.dedupKey).then(function (sent) {
              if (sent) {
                summary.skipped++;
                return null;
              }
              summary.matched++;
              return sendSubscribe(rule.userId, hit.template, hit.data).then(function (result) {
                // 无论成败都要落库：失败了也要记，否则下次会重复尝试同一件事
                return dao.logs.insert({
                  userId: rule.userId,
                  dedupKey: hit.dedupKey,
                  sent: !!result.sent,
                  failReason: result.sent ? null : (result.reason || 'UNKNOWN'),
                  payload: { type: hit.type, title: hit.title, price: hit.price, data: hit.data }
                }).then(function () {
                  if (result.sent) summary.sent++;
                  else summary.failed++;
                  summary.details.push({
                    userId: rule.userId,
                    type: hit.type,
                    sent: !!result.sent,
                    reason: result.reason
                  });
                });
              });
            });
          });
        }, Promise.resolve());
      });
    }, Promise.resolve());
  }).then(function () {
    return summary;
  });
}

module.exports = { run: run, matchRule: matchRule, TEMPLATE_FIELDS: TEMPLATE_FIELDS };
