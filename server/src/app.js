/**
 * Express 应用装配
 *
 * 路由分两组：
 *   /api/*  业务接口（小程序调用）
 *   /health 健康检查（部署探活用）
 */
const express = require('express');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');

function createApp() {
  var app = express();

  app.disable('x-powered-by');

  // 小程序端发的是 JSON，但提醒规则数组可能比较大，给足限制
  app.use(express.json({ limit: '1mb' }));

  // 记录请求，方便排查「小程序到底打过来了没有」
  app.use(function (req, res, next) {
    var start = Date.now();
    res.on('finish', function () {
      console.log('[http] ' + req.method + ' ' + req.originalUrl +
        ' ' + res.statusCode + ' ' + (Date.now() - start) + 'ms');
    });
    next();
  });

  app.get('/health', function (req, res) {
    res.json({ ok: true, data: { status: 'up', time: new Date().toISOString() } });
  });

  app.use('/api', authRoutes);
  app.use('/api', apiRoutes);

  // 兜底：路径拼错时也用统一外壳，别返回 HTML 错误页
  app.use(function (req, res) {
    res.status(404).json({ ok: false, message: '接口不存在: ' + req.path, code: 'NOT_FOUND' });
  });

  // 统一错误处理
  app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    console.error('[app] 未捕获异常', err);
    res.status(500).json({ ok: false, message: (err && err.message) || '服务器内部错误', code: 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createApp: createApp };
