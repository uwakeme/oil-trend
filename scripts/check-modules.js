/**
 * 运行时模块加载冒烟测试
 *
 * 为什么需要它：`node --check` 只查语法，查不出「函数体已删、导出项还留着」
 * 这类运行期 ReferenceError。2026-11-11 那次就踩过：
 *   utils/api.js 里删掉了 saveAlertHistory 的函数体，却忘了删 module.exports
 *   里的同名导出项 → 模块一被 require 就抛 ReferenceError → 五个页面全部白屏。
 * 静态检查全绿，只有真正把模块加载起来才会暴露。
 *
 * 做法：在 Node 里 stub 掉小程序运行时全局（wx / App / Page / Component 等），
 * 然后把运行时目录下的所有 JS 都 require 一遍，任何加载期异常都算失败。
 * 自建后端（server/src）一起查：第三方依赖（express / pg）用桩替代，
 * 服务端没有模拟器兜底，部署后才发现就晚了。
 *
 * 用法：node scripts/check-modules.js
 * 退出码：0 = 全部可加载；1 = 有模块加载失败
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

// 会被 require 的运行时目录
const RUNTIME_DIRS = ['pages', 'components', 'utils', 'data', 'config'];
const ENTRY_FILES = ['app.js'];
// 自建后端源码目录
const SERVER_SRC = path.join('server', 'src');

/* ---------- 小程序运行时 stub ---------- */

const storage = {};

function createWxStub() {
  const explicit = {
    getStorageSync: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''),
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: (key) => { delete storage[key]; },
    getSystemInfoSync: () => ({
      windowWidth: 375, windowHeight: 667, pixelRatio: 2,
      statusBarHeight: 20, safeArea: { top: 20, bottom: 667, left: 0, right: 375 }
    }),
    getMenuButtonBoundingClientRect: () => ({ top: 24, bottom: 56, left: 280, right: 360, width: 80, height: 32 }),
    nextTick: (fn) => Promise.resolve().then(fn),
    createSelectorQuery: () => ({
      in: function () { return this; },
      select: function () { return this; },
      selectAll: function () { return this; },
      selectViewport: function () { return this; },
      boundingClientRect: function () { return this; },
      scrollOffset: function () { return this; },
      fields: function () { return this; },
      exec: function (cb) { if (cb) cb([]); }
    }),
    createAnimation: () => ({
      opacity: () => ({ translateX: () => ({ step: () => ({}), export: () => ({}) }) }),
      translateX: () => ({ step: () => ({}), export: () => ({}) }),
      step: () => ({}), export: () => ({})
    }),
    login: (opts) => { if (opts && opts.fail) opts.fail({ errMsg: 'STUB_LOGIN' }); },
    request: (opts) => { if (opts && opts.fail) opts.fail({ errMsg: 'STUB_REQUEST' }); }
  };

  // 其余 wx.xxx 一律返回空函数，避免 stub 不全导致误报
  return new Proxy(explicit, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return function () { return undefined; };
    }
  });
}

/* ---------- 自建后端依赖桩 ---------- */

// server/ 的第三方依赖（express / pg）本机不一定装了，
// 门禁只要求「能加载」，不要求真连数据库。
function createExpressStub() {
  function app() { return app; }
  app.use = function () { return app; };
  app.get = function () { return app; };
  app.post = function () { return app; };
  app.listen = function () { return { close: function () {} }; };
  app.disable = function () { return app; };
  app.set = function () { return app; };
  // Router 是个独立导出：express.Router()
  app.Router = function () { return app; };
  return app;
}

function createPgStub() {
  function Pool() {}
  Pool.prototype.on = function () {};
  Pool.prototype.query = function () { return Promise.resolve({ rows: [] }); };
  Pool.prototype.connect = function () {
    return Promise.resolve({
      query: function () { return Promise.resolve({ rows: [] }); },
      release: function () {}
    });
  };
  return { Pool: Pool };
}

// 拦截第三方依赖，返回桩
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'express') return createExpressStub();
  if (request === 'pg') return createPgStub();
  return originalLoad.apply(this, arguments);
};

global.wx = createWxStub();
global.App = function () {};
global.Page = function () {};
global.Component = function () {};
global.Behavior = function () {};
global.getApp = function () { return { globalData: {} }; };
global.getCurrentPages = function () { return []; };
global.__wxConfig = { envVersion: 'develop' };

/* ---------- 收集要加载的文件 ---------- */

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  entries.forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  });
  return out;
}

function relOf(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

const files = [];
ENTRY_FILES.forEach((f) => {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) files.push(full);
});
RUNTIME_DIRS.forEach((dir) => walk(path.join(ROOT, dir), files));

const serverFiles = [];
walk(path.join(ROOT, SERVER_SRC), serverFiles);

if (!files.length && !serverFiles.length) {
  console.error('没有找到任何运行时模块，检查路径配置：' + RUNTIME_DIRS.join(', '));
  process.exit(1);
}

/* ---------- 逐个加载 ---------- */

function loadAll(list) {
  const failures = [];
  list.forEach((file) => {
    try {
      require(file);
    } catch (err) {
      failures.push({ rel: relOf(file), message: (err && err.message) || String(err) });
    }
  });
  return failures;
}

const failures = loadAll(files);
const serverFailures = loadAll(serverFiles);

console.log('已加载 ' + (files.length - failures.length) + '/' + files.length + ' 个运行时模块');
if (serverFiles.length) {
  console.log('已加载 ' + (serverFiles.length - serverFailures.length) + '/' + serverFiles.length + ' 个服务端模块');
}

if (failures.length || serverFailures.length) {
  if (failures.length) {
    console.log('\n--- 运行时模块加载失败 ---');
    failures.forEach((f) => {
      console.log('  ' + f.rel);
      console.log('    ' + f.message);
    });
  }
  if (serverFailures.length) {
    console.log('\n--- 服务端模块加载失败 ---');
    serverFailures.forEach((f) => {
      console.log('  ' + f.rel);
      console.log('    ' + f.message);
    });
  }
  console.log('\n模块加载失败：通常是「函数体已删但引用还在」这类运行期错误，静态语法检查查不出来。');
  process.exit(1);
}

console.log('全部运行时模块与服务端模块加载通过。');
process.exit(0);
