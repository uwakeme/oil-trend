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
 * 云函数也一起查：stub 掉 wx-server-sdk 再加载入口和它的本地模块，
 * 同一类错误云端也要挡住。另外会扫一遍已从 SDK 移除的 API 引用。
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
// 云函数入口目录（_shared 是被引用的模块，不算入口）
const CLOUD_DIR = 'cloudfunctions';

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

/* ---------- 云函数 stub（wx-server-sdk） ---------- */

/**
 * wx-server-sdk 桩：只求「能加载」，不做任何真实读写。
 * 这里要抓的是加载期异常，数据库调用等到线上再验。
 */
function createCloudSdkStub() {
  function collection() {
    return {
      where: function () { return this; },
      orderBy: function () { return this; },
      skip: function () { return this; },
      limit: function () { return this; },
      get: function () { return Promise.resolve({ data: [] }); },
      add: function () { return Promise.resolve({ _id: 'stub' }); },
      update: function () { return Promise.resolve({}); },
      remove: function () { return Promise.resolve({}); },
      count: function () { return Promise.resolve({ total: 0 }); },
      doc: function () {
        return {
          get: function () { return Promise.resolve({ data: {} }); },
          update: function () { return Promise.resolve({}); },
          remove: function () { return Promise.resolve({}); }
        };
      }
    };
  }
  return {
    init: function () {},
    DYNAMIC_CURRENT_ENV: 'stub-env',
    database: function () {
      return {
        collection: collection,
        command: new Proxy({}, {
          get: function (target, prop) {
            if (typeof prop === 'symbol') return undefined;
            return function (value) { return value; };
          }
        })
      };
    },
    getWXContext: function () { return { OPENID: 'stub-openid' }; },
    httpclient: {
      request: function () { return Promise.resolve({ statusCode: 200, data: '' }); }
    },
    openapi: {
      subscribeMessage: { send: function () { return Promise.resolve({}); } }
    }
  };
}

// 拦截 require('wx-server-sdk')，返回桩
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return createCloudSdkStub();
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

const cloudFiles = [];
const cloudRoot = path.join(ROOT, CLOUD_DIR);
if (fs.existsSync(cloudRoot)) {
  fs.readdirSync(cloudRoot, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isDirectory() || entry.name === '_shared') return;
    const dir = path.join(cloudRoot, entry.name);
    // 入口和它引用的本地模块都要加载：只加载 index.js 的话，
    // 「删了 http-client.js 的函数体、留着 require」这类错误查不出来
    const entryFile = path.join(dir, 'index.js');
    if (fs.existsSync(entryFile)) cloudFiles.push(entryFile);
    fs.readdirSync(dir, { withFileTypes: true }).forEach((f) => {
      if (!f.isFile() || !f.name.endsWith('.js')) return;
      if (f.name === 'index.js' || f.name === 'shared.js') return;
      cloudFiles.push(path.join(dir, f.name));
    });
  });
}

if (!files.length && !cloudFiles.length) {
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
const cloudFailures = loadAll(cloudFiles);

/* ---------- 云函数不得引用已从 SDK 移除的 API ---------- */

// wx-server-sdk 4.x 底层从 tcb-admin-node 换成 @cloudbase/node-sdk，
// cloud.httpclient 整个消失了（实测 2.6.3 顶层本来也没有，
// 那是 tcb-admin-node 的东西）。这类引用静态检查查不出来，
// 部署后第一次真跑采集才会炸 —— 所以在这里挡住。
const REMOVED_SDK_APIS = [
  { name: 'cloud.httpclient', hint: '4.x 已移除，改用 cloudfunctions/oilCollector/http-client.js' }
];

const apiProblems = [];
cloudFiles.forEach(function (file) {
  // 只看代码行：注释里提到某个 API 名字（比如说明迁移原因）不该误报
  const codeLines = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(function (line) { return line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, ''); })
    .join('\n');
  REMOVED_SDK_APIS.forEach(function (api) {
    if (codeLines.indexOf(api.name) !== -1) {
      apiProblems.push({ rel: relOf(file), api: api.name, hint: api.hint });
    }
  });
});

console.log('已加载 ' + (files.length - failures.length) + '/' + files.length + ' 个运行时模块');
if (cloudFiles.length) {
  console.log('已加载 ' + (cloudFiles.length - cloudFailures.length) + '/' + cloudFiles.length + ' 个云函数模块');
}

if (apiProblems.length) {
  console.log('\n--- 云函数引用了已移除的 SDK API ---');
  apiProblems.forEach(function (p) {
    console.log('  ' + p.rel + ' -> ' + p.api);
    console.log('    ' + p.hint);
  });
}

if (failures.length || cloudFailures.length || apiProblems.length) {
  if (failures.length) {
    console.log('\n--- 运行时模块加载失败 ---');
    failures.forEach((f) => {
      console.log('  ' + f.rel);
      console.log('    ' + f.message);
    });
  }
  if (cloudFailures.length) {
    console.log('\n--- 云函数加载失败 ---');
    cloudFailures.forEach((f) => {
      console.log('  ' + f.rel);
      console.log('    ' + f.message);
    });
  }
  console.log('\n模块加载失败：通常是「函数体已删但引用还在」这类运行期错误，静态语法检查查不出来。');
  process.exit(1);
}

console.log('全部运行时模块与云函数入口加载通过。');
process.exit(0);
