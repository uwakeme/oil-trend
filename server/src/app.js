/**
 * Express 应用装配
 *
 * 路由分三组：
 *   /api/*   业务接口（小程序调用）
 *   /health  存活检查（进程还在不在）
 *   /ready   就绪检查（配置齐全 + 数据库连得上）
 *
 * ⚠️ /health 和 /ready 的区别很要紧：
 *   /health 只说明进程活着 —— 数据库连错了库它照样返回 200，
 *   部署流水线的健康检查探的就是它，等于假绿。
 *   /ready 才真的去连库，部署流水线要探的是它。
 */
const express = require('express');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const config = require('./config');
const db = require('./db');
const errors = require('./errors');

/**
 * 极简限流（内存滑动窗口）。
 *
 * ⚠️ 原来整个服务零限流：/api/locate 不用登录、没有次数上限，
 * 而它每次请求都要对 31 个省的多边形全量重算一次（同步、阻塞事件循环），
 * 一个脚本就能把 CPU 打满。写接口也没有条数上限，
 * express.json 允许 1mb，一个请求能塞进上万条规则。
 *
 * 不引第三方依赖：进程内计数已经够用，多实例部署时每个实例各算各的。
 */
function rateLimit(options) {
  var opts = options || {};
  var windowMs = opts.windowMs || 60000;
  var max = opts.max || 30;
  var buckets = {};
  var requests = 0;

  // 定期清掉过期桶，别让内存被大量一次性 IP 撑爆
  function sweep(now) {
    var keys = Object.keys(buckets);
    keys.forEach(function (k) {
      var hits = buckets[k].filter(function (t) { return now - t < windowMs; });
      if (hits.length) buckets[k] = hits;
      else delete buckets[k];
    });
  }

  return function (req, res, next) {
    var ip = req.ip ||
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';
    var key = (opts.key ? opts.key(req) : '') + '|' + ip;
    var now = Date.now();
    var hits = (buckets[key] || []).filter(function (t) { return now - t < windowMs; });
    if (hits.length >= max) {
      res.status(429).json({ ok: false, message: errors.PUBLIC_ERRORS.RATE_LIMITED, code: 'RATE_LIMITED' });
      return;
    }
    hits.push(now);
    buckets[key] = hits;
    requests++;
    if (requests % 500 === 0) sweep(now);
    next();
  };
}

function createApp() {
  var app = express();

  app.disable('x-powered-by');

  // ⚠️ 限流必须按**真实客户端 IP** 分桶。
  // 部署在 nginx 后面时 req.ip 恒为 127.0.0.1（反代地址），
  // 不开 trust proxy 的话所有用户共用一个桶：一个人打满，全站 429，
  // 比「限流形同虚设」更糟（DoS 放大）。
  //
  // 这里是 1 跳：nginx → node。nginx 用 $proxy_add_x_forwarded_for 追加，
  // X-Forwarded-For 最右侧一项才是真实客户端 IP；trust proxy: 1 正是取这一项，
  // 客户端自己伪造的 XFF 在更左边，不影响判定。
  app.set('trust proxy', 1);

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

  // 存活检查：只说明进程还在
  app.get('/health', function (req, res) {
    res.json({ ok: true, data: { status: 'up', time: new Date().toISOString() } });
  });

  // 就绪检查：配置齐全 + 数据库真的连得上
  app.get('/ready', function (req, res) {
    var check = config.validate();
    if (check.errors.length) {
      res.status(503).json({
        ok: false,
        message: '配置不完整',
        code: 'NOT_READY',
        data: { status: 'not-ready', errors: check.errors }
      });
      return;
    }
    db.query('SELECT 1 AS ok').then(function () {
      res.json({ ok: true, data: { status: 'ready', time: new Date().toISOString() } });
    }).catch(function (err) {
      console.error('[ready] 数据库不可用', err);
      res.status(503).json({ ok: false, message: '数据库不可用', code: 'NOT_READY' });
    });
  });

  // 限流：登录、定位、写入类接口收紧
  app.use('/api/login', rateLimit({ max: 20, windowMs: 60000 }));
  app.use('/api/locate', rateLimit({ max: 30, windowMs: 60000 }));
  app.use('/api/rules', rateLimit({ max: 60, windowMs: 60000 }));
  app.use('/api/history', rateLimit({ max: 60, windowMs: 60000 }));

  // 读接口也要限：/api/trend 一次查三张表、/api/home 拼三十多行，
  // 不限流的话一个脚本就能把连接池打满。
  // 额度比写接口宽松：小程序切页会连打几个读接口，别把正常用户挡在门外。
  app.use('/api/trend', rateLimit({ max: 60, windowMs: 60000 }));
  app.use('/api/home', rateLimit({ max: 120, windowMs: 60000 }));
  app.use('/api/notices', rateLimit({ max: 120, windowMs: 60000 }));
  app.use('/api/market', rateLimit({ max: 120, windowMs: 60000 }));
  app.use('/api/regions', rateLimit({ max: 60, windowMs: 60000 }));
  app.use('/api/sync-status', rateLimit({ max: 60, windowMs: 60000 }));

  app.use('/api', authRoutes);
  app.use('/api', apiRoutes);

  // 兜底：路径拼错时也用统一外壳，别返回 HTML 错误页
  app.use(function (req, res) {
    res.status(404).json({ ok: false, message: errors.PUBLIC_ERRORS.NOT_FOUND, code: 'NOT_FOUND' });
  });

  // 统一错误处理
  app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    console.error('[app] 未捕获异常', err);
    res.status(500).json(errors.publicError(err));
  });

  return app;
}

module.exports = { createApp: createApp, rateLimit: rateLimit };