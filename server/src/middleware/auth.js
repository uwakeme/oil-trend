/**
 * 登录态中间件
 *
 * 需要用户身份的接口（提醒规则、提醒记录）挂这个。
 * 没带 token 或 token 无效 → 401，前端会回落到本地存储。
 */
const auth = require('../services/auth');

function requireAuth(req, res, next) {
  var header = req.headers.authorization || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  var user = auth.verifyToken(token);
  if (!user) {
    res.status(401).json({ ok: false, message: '未登录或登录态已过期', code: 'UNAUTHORIZED' });
    return;
  }
  req.user = user;
  next();
}

module.exports = { requireAuth: requireAuth };
