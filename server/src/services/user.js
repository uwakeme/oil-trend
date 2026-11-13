/**
 * 用户数据：提醒规则与提醒记录
 *
 * 逻辑与早期云函数实现一致（云函数已下线，见 git 历史）。
 *
 * openid 从登录 token 里取（中间件已校验并挂在 req.user 上）。
 *
 * ⚠️ 这一层还负责**字段名翻译**：小程序端叫 forecastDrop，
 * 库里叫 predict_drop。以前两边各写各的，翻译漏了，
 * 结果「预测下调」开关每次打开提醒页都丢失（读回来是 undefined）。
 * 翻译统一放在这里，DAO 层只见库里的名字。
 */
const dao = require('../dao');

/**
 * 小程序端字段 → 库里字段。
 *
 * subscribeGranted 原样传过去（三态）：
 *   undefined = 这次没带这个字段，库里保持原值；
 *   true     = 刚拿到微信的一次性授权；
 *   false    = 明确撤销。
 */
function toDbRule(userId, rule) {
  var forecastDrop = rule.forecastDrop === undefined ? rule.predictDrop : rule.forecastDrop;
  return {
    userId: userId,
    regionCode: rule.regionCode,
    fuelId: rule.fuelId,
    officialDrop: rule.officialDrop === undefined ? true : !!rule.officialDrop,
    targetPrice: rule.targetPrice === undefined ? null : rule.targetPrice,
    predictDrop: !!forecastDrop,
    targetEnabled: rule.targetEnabled === undefined ? true : !!rule.targetEnabled,
    subscribeGranted: rule.subscribeGranted === undefined ? null : !!rule.subscribeGranted,
    extra: rule.extra
  };
}

/**
 * 库里字段 → 小程序端字段。
 *
 * predictDrop 读出来是小程序不认识的 forecastDrop，
 * targetEnabled / subscribeUsedAt 一并补上。
 */
function toApiRule(rule) {
  var out = {
    id: rule.id,
    userId: rule.userId,
    regionCode: rule.regionCode,
    fuelId: rule.fuelId,
    officialDrop: !!rule.officialDrop,
    targetPrice: rule.targetPrice === null || rule.targetPrice === undefined ? null : Number(rule.targetPrice),
    forecastDrop: !!rule.predictDrop,
    targetEnabled: rule.targetEnabled === undefined ? true : !!rule.targetEnabled,
    subscribeGranted: !!rule.subscribeGranted,
    subscribeUsedAt: rule.subscribeUsedAt || null
  };
  return out;
}

function actionRulesList(userId) {
  return dao.rules.listByUser(userId).then(function (rules) {
    return { rules: rules.map(toApiRule) };
  });
}

/**
 * 保存提醒规则。
 * 早期实现是「先查旧的，找到就 update，找不到就 add」，
 * 这里靠 (user_id, region_code, fuel_id) 唯一索引直接 upsert，
 * 语义一样但少一次查询，也不会并发写重复。
 */
function actionRulesSave(userId, rules) {
  var list = rules || [];
  if (!list.length) return Promise.resolve({ rules: [] });

  var tasks = list.map(function (rule) {
    return dao.rules.upsert(toDbRule(userId, rule));
  });

  return Promise.all(tasks).then(function () {
    return { rules: list };
  });
}

function actionHistoryList(userId) {
  return dao.logs.listByUser(userId, 50).then(function (history) {
    return { history: history };
  });
}

function actionHistorySave(userId, history) {
  var list = history || [];
  if (!list.length) return Promise.resolve({ history: [] });

  var tasks = list.map(function (item) {
    return dao.logs.insert({
      userId: userId,
      dedupKey: item.dedupKey || ('local:' + userId + ':' + (item.time || Date.now()) + ':' + Math.random().toString(36).slice(2)),
      sent: !!item.sent,
      failReason: item.failReason || null,
      payload: item
    });
  });

  return Promise.all(tasks).then(function () {
    return { history: list };
  });
}

module.exports = {
  actionRulesList: actionRulesList,
  actionRulesSave: actionRulesSave,
  actionHistoryList: actionHistoryList,
  actionHistorySave: actionHistorySave,
  toDbRule: toDbRule,
  toApiRule: toApiRule
};
