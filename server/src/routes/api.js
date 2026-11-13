/**
 * 业务路由
 *
 * 统一响应外壳：
 *   { ok: true,  data: {...} }
 *   { ok: false, message: '...', code: '...' }
 *
 * 前端 utils/cloud.js 按这个约定解析，ok === false 会 reject 并回落演示源。
 */
const express = require('express');
const query = require('../services/query');
const notices = require('../services/notices');
const user = require('../services/user');
const locate = require('../services/locate');
const errors = require('../errors');
const { requireAuth } = require('../middleware/auth');

var router = express.Router();

function ok(data) {
  return { ok: true, data: data };
}

/**
 * 包一层，把异常转成统一外壳。
 *
 * ⚠️ 不再把 err.message 原样返回：会带出 pg 的 SQL 错误、微信 errmsg 等内部信息。
 * 白名单里的业务错误码透出原文，其余换成固定文案（见 src/errors.js）。
 */
function handle(fn) {
  return function (req, res) {
    Promise.resolve()
      .then(function () { return fn(req, res); })
      .catch(function (err) {
        console.error('[api]', req.method, req.path, err);
        // 状态码要分：业务错误 4xx、内部错误 5xx。
        // 全 200 的话监控与 CI 都看不出服务端出问题了。
        res.status(errors.statusOf(err)).json(errors.publicError(err));
      });
  };
}

/* ---------------- 查询类（无需登录） ---------------- */

router.get('/regions', handle(function (req, res) {
  return query.actionRegions().then(function (data) { res.json(ok(data)); });
}));

router.get('/locate', handle(function (req, res) {
  // 经纬度 → 省份。参数缺失或不在国内时返回 regionCode=null、match='none'，
  // 不报错：小程序端拿不到省份就保持原地区，不影响其他功能。
  res.json(ok(locate.locateByLatLng(req.query.lat, req.query.lng)));
}));

router.get('/home', handle(function (req, res) {
  return query.actionHome(req.query).then(function (data) { res.json(ok(data)); });
}));

router.get('/trend', handle(function (req, res) {
  return query.actionTrend(req.query).then(function (data) { res.json(ok(data)); });
}));

router.get('/notices', handle(function (req, res) {
  return notices.actionNotices(req.query).then(function (data) { res.json(ok(data)); });
}));

router.get('/market', handle(function (req, res) {
  return notices.actionMarket(req.query).then(function (data) { res.json(ok(data)); });
}));

router.get('/sync-status', handle(function (req, res) {
  return notices.actionSyncStatus().then(function (data) { res.json(ok(data)); });
}));

/* ---------------- 用户类（需要登录） ---------------- */

router.get('/rules', requireAuth, handle(function (req, res) {
  return user.actionRulesList(req.user.openid).then(function (data) { res.json(ok(data)); });
}));

router.post('/rules', requireAuth, handle(function (req, res) {
  return user.actionRulesSave(req.user.openid, (req.body && req.body.rules) || [])
    .then(function (data) { res.json(ok(data)); });
}));

router.get('/history', requireAuth, handle(function (req, res) {
  return user.actionHistoryList(req.user.openid).then(function (data) { res.json(ok(data)); });
}));

router.post('/history', requireAuth, handle(function (req, res) {
  return user.actionHistorySave(req.user.openid, (req.body && req.body.history) || [])
    .then(function (data) { res.json(ok(data)); });
}));

module.exports = router;
