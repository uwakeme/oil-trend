/**
 * 业务路由
 *
 * 统一响应外壳与云函数一致：
 *   { ok: true,  data: {...} }
 *   { ok: false, message: '...', code: '...' }
 *
 * 前端 utils/cloud.js 按这个约定解析，ok === false 会 reject 并回落演示源。
 */
const express = require('express');
const query = require('../services/query');
const notices = require('../services/notices');
const user = require('../services/user');
const { requireAuth } = require('../middleware/auth');

var router = express.Router();

function ok(data) {
  return { ok: true, data: data };
}

function fail(message, code) {
  return { ok: false, message: message, code: code || 'ERROR' };
}

/** 包一层，把异常转成统一外壳 */
function handle(fn) {
  return function (req, res) {
    Promise.resolve()
      .then(function () { return fn(req, res); })
      .catch(function (err) {
        console.error('[api]', req.method, req.path, err);
        res.json(fail((err && err.message) || String(err), (err && err.code) || 'INTERNAL_ERROR'));
      });
  };
}

/* ---------------- 查询类（无需登录） ---------------- */

router.get('/regions', handle(function (req, res) {
  return query.actionRegions().then(function (data) { res.json(ok(data)); });
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
