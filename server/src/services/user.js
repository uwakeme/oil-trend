/**
 * 用户数据：提醒规则与提醒记录
 *
 * 与 cloudfunctions/oilApi/index.js 的 actionRulesList / actionRulesSave /
 * actionHistoryList / actionHistorySave 一致。
 *
 * 云函数用 cloud.getWXContext() 拿 openid，自建改成从 token 里取
 * （中间件已经校验过并挂在 req.user 上）。
 */
const dao = require('../dao');

function actionRulesList(userId) {
  return dao.rules.listByUser(userId).then(function (rules) {
    return { rules: rules };
  });
}

/**
 * 保存提醒规则。
 * 云函数那边是「先查旧的，找到就 update，找不到就 add」，
 * 这里靠 (user_id, region_code, fuel_id) 唯一索引直接 upsert，
 * 语义一样但少一次查询，也不会并发写重复。
 */
function actionRulesSave(userId, rules) {
  var list = rules || [];
  if (!list.length) return Promise.resolve({ rules: [] });

  var tasks = list.map(function (rule) {
    return dao.rules.upsert({
      userId: userId,
      regionCode: rule.regionCode,
      fuelId: rule.fuelId,
      officialDrop: rule.officialDrop,
      targetPrice: rule.targetPrice,
      predictDrop: rule.predictDrop,
      subscribeGranted: rule.subscribeGranted,
      extra: rule.extra
    });
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
  actionHistorySave: actionHistorySave
};
