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
const shared = require('../shared/shared');

/* ---------------- 入参校验 ---------------- */

/** 一次最多接受多少条规则 / 记录 */
var MAX_RULES = 50;
var MAX_HISTORY = 50;

/** 项目支持的油品标号 */
var FUEL_IDS = ['92', '95', '98', '0'];

function badRequest(message, code) {
  var err = new Error(message);
  err.code = code || 'INVALID_INPUT';
  return err;
}

/**
 * 校验提醒规则。
 *
 * ⚠️ 原来完全不校验：targetPrice 传 "abc" 会直接进 NUMERIC(6,2) 报 500，
 * regionCode 传乱码会静默查不到数据，rules 数组也没有长度上限 ——
 * express.json 允许 1mb，一个请求能塞进上万条，打出上万条独立 SQL。
 */
function validateRules(rules) {
  if (!Array.isArray(rules)) throw badRequest('规则格式不正确', 'INVALID_RULES');
  if (rules.length > MAX_RULES) {
    throw badRequest('一次最多提交 ' + MAX_RULES + ' 条规则', 'TOO_MANY_RULES');
  }
  rules.forEach(function (rule) {
    if (!rule || typeof rule !== 'object') throw badRequest('规则格式不正确', 'INVALID_RULES');
    if (!rule.regionCode || !shared.findRegion(rule.regionCode)) {
      throw badRequest('地区代码不存在：' + (rule.regionCode || ''), 'INVALID_REGION');
    }
    if (FUEL_IDS.indexOf(String(rule.fuelId)) < 0) {
      throw badRequest('油品标号不存在：' + (rule.fuelId || ''), 'INVALID_FUEL');
    }
    if (rule.targetPrice !== undefined && rule.targetPrice !== null) {
      var target = Number(rule.targetPrice);
      if (!isFinite(target) || target <= 0 || target > 100) {
        throw badRequest('目标价不合法', 'INVALID_TARGET_PRICE');
      }
    }
  });
}

/** 校验提醒记录 */
function validateHistory(history) {
  if (!Array.isArray(history)) throw badRequest('记录格式不正确', 'INVALID_HISTORY');
  if (history.length > MAX_HISTORY) {
    throw badRequest('一次最多提交 ' + MAX_HISTORY + ' 条记录', 'TOO_MANY_HISTORY');
  }
  history.forEach(function (item) {
    if (!item || typeof item !== 'object') throw badRequest('记录格式不正确', 'INVALID_HISTORY');
  });
}

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
  validateRules(list);

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
  validateHistory(list);

  var tasks = list.map(function (item) {
    // ⚠️ dedup_key 必须由服务端加前缀，不能直接用客户端给的值：
    // 系统推送的去重键是 [openid, 地区, 油品, 类型, 日期].join('::')，
    // 客户端要是能指定这个值，就能提前占住全局去重键，
    // 让某次系统推送被永久跳过。强制加 'local:' 前缀后不可能撞上。
    var raw = item.dedupKey || '';
    var suffix = raw || ((item.time || Date.now()) + ':' + Math.random().toString(36).slice(2));
    return dao.logs.insert({
      userId: userId,
      dedupKey: 'local:' + userId + ':' + suffix,
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
