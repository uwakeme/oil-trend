/**
 * 登录路由
 *
 * 自建后端没有 cloud.getWXContext()，openid 要自己换：
 *   小程序 wx.login() 拿 code → 这里 code2session → 签发 token
 */
const express = require('express');
const auth = require('../services/auth');
const dao = require('../dao');
const errors = require('../errors');

var router = express.Router();

router.post('/login', function (req, res) {
  var code = req.body && req.body.code;
  if (!code) {
    res.json({ ok: false, message: errors.PUBLIC_ERRORS.NO_CODE, code: 'NO_CODE' });
    return;
  }
  auth.login(code).then(function (result) {
    // 记一次活跃时间
    return dao.users.touch(result.openid).then(function () { return result; });
  }).then(function (result) {
    res.json({ ok: true, data: { token: result.token, openid: result.openid } });
  }).catch(function (err) {
    console.error('[auth] login failed', err.message);
    // ⚠️ 不透传 err.message：微信返回的 errmsg 里可能带内部细节
    res.json(errors.publicError(err));
  });
});

module.exports = router;
