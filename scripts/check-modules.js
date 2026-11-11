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
 *
 * 用法：node scripts/check-modules.js
 * 退出码：0 = 全部可加载；1 = 有模块加载失败
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 会被 require 的运行时目录（云函数不在小程序包里，另行 node --check）
const RUNTIME_DIRS = ['pages', 'components', 'utils', 'data', 'config'];
const ENTRY_FILES = ['app.js'];

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
    cloud: {
      init: () => ({}),
      callFunction: () => Promise.reject(new Error('STUB_CLOUD')),
      database: () => ({
        collection: () => ({
          where: () => ({ get: () => Promise.resolve({ data: [] }) }),
          get: () => Promise.resolve({ data: [] }),
          doc: () => ({ get: () => Promise.resolve({ data: {} }), update: () => Promise.resolve({}) }),
          add: () => Promise.resolve({ _id: 'stub' }),
          update: () => Promise.resolve({})
        })
      })
    }
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

global.wx = createWxStub();
global.App = function () {};
global.Page = function () {};
global.Component = function () {};
global.Behavior = function () {};
global.getApp = function () { return { globalData: {} }; };
global.getCurrentPages = function () { return []; };
global.__wxConfig = { envVersion: 'develop' };

/* ---------- 收集运行时文件 ---------- */

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

const files = [];
ENTRY_FILES.forEach((f) => {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) files.push(full);
});
RUNTIME_DIRS.forEach((dir) => walk(path.join(ROOT, dir), files));

if (!files.length) {
  console.error('没有找到任何运行时模块，检查路径配置：' + RUNTIME_DIRS.join(', '));
  process.exit(1);
}

/* ---------- 逐个加载 ---------- */

const failures = [];
files.forEach((file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  try {
    require(file);
  } catch (err) {
    failures.push({ rel, message: (err && err.message) || String(err) });
  }
});

console.log('已加载 ' + (files.length - failures.length) + '/' + files.length + ' 个运行时模块');

if (failures.length) {
  console.log('\n--- 加载失败 ---');
  failures.forEach((f) => {
    console.log('  ' + f.rel);
    console.log('    ' + f.message);
  });
  console.log('\n模块加载失败：通常是「函数体已删但引用还在」这类运行期错误，静态语法检查查不出来。');
  process.exit(1);
}

console.log('全部运行时模块加载通过。');
process.exit(0);
