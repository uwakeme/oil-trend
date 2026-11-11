/**
 * 登录路由
 *
 * 自建后端没有 cloud.getWXContext()，openid 要自己换：
 *   小程序 wx.login() 拿 code → 这里 code2session → 签发 token
 */
const express = require('express');
const auth = require('../services/auth');
const dao = require('../dao');

var router = express.Router();

router.post('/login', function (req, res) {
  var code = req.body && req.body.code;
  if (!code) {
    res.json({ ok: false, message: '缺少 code', code: 'NO_CODE' });
    return;
  }
  auth.login(code).then(function (result) {
    // 记一次活跃时间，和云函数 currentUser() 的行为一致
    return dao.users.touch(result.openid).then(function () { return result; });
  }).then(function (result) {
    res.json({ ok: true, data: { token: result.token, openid: result.openid } });
  }).catch(function (err) {
    console.error('[auth] login failed', err.message);
    res.json({ ok: false, message: err.message || '登录失败', code: err.code || 'LOGIN_FAILED' });
  });
});

module.exports = router;
