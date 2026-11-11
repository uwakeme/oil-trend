/**
 * 小程序验证脚本（自实现 IDE 自动化协议客户端）
 *
 * 为什么不用 miniprogram-automator：
 *   早先 IDE 2.01.x 的 Tool.getInfo 只返回 { version }，
 *   而 automator 0.13 读的是 SDKVersion，握手阶段直接崩。
 *   现在 IDE 2.02 已同时返回 version 与 SDKVersion，但协议本身很简单
 *   （{id, method, params} → {id, result}），自己实现更省事，也少一个依赖。
 *
 * 用法：
 *   npm i --prefix .tooling ws
 *   node scripts/verify-in-devtools.js
 *
 * 前置：开发者工具已登录，服务端口开启，且已用
 *   cli.bat auto --project <path> --auto-port <port>
 *   启动自动化服务（端口可用 AUTO_WS 环境变量覆盖）。
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ws 可能装在 .tooling/node_modules（见 README 的安装命令）
function loadWs() {
  try { return require('ws'); } catch (e) {
    return require(path.join(ROOT, '.tooling', 'node_modules', 'ws'));
  }
}
const WebSocket = loadWs();
const fs = require('fs');
const crypto = require('crypto');

const OUT = path.join(ROOT, 'docs', 'screenshots');
const WS = process.env.AUTO_WS || 'ws://127.0.0.1:9421';

const PAGES = [
  { path: '/pages/index/index',   name: '01-price-home' },
  { path: '/pages/trend/trend',   name: '02-trend' },
  { path: '/pages/notice/notice', name: '03-notice' },
  { path: '/pages/global/global', name: '04-global' },
  { path: '/pages/alert/alert',   name: '05-alert' }
];

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function norm(p) { return String(p || '').replace(/^\//, ''); }

class Client {
  constructor(url) {
    this.url = url;
    this.callbacks = new Map();
    this.events = [];
  }

  connect() {
    const self = this;
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(self.url);
      self.ws = ws;
      const timer = setTimeout(function () { reject(new Error('连接超时')); }, 15000);
      ws.on('open', function () { clearTimeout(timer); resolve(self); });
      ws.on('error', function (e) { clearTimeout(timer); reject(e); });
      ws.on('close', function () {
        self.callbacks.forEach(function (cb) { cb.reject(new Error('连接已关闭')); });
        self.callbacks.clear();
      });
      ws.on('message', function (data) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        if (!msg.id) { self.events.push(msg); return; }
        const cb = self.callbacks.get(msg.id);
        if (!cb) return;
        self.callbacks.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else cb.resolve(msg.result);
      });
    });
  }

  send(method, params) {
    const self = this;
    const id = crypto.randomUUID();
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        if (self.callbacks.has(id)) {
          self.callbacks.delete(id);
          reject(new Error('方法超时: ' + method));
        }
      }, 20000);
      self.callbacks.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      });
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  currentPage() { return this.send('App.getCurrentPage'); }
  pageStack() { return this.send('App.getPageStack'); }
  screenshot() { return this.send('App.captureScreenshot'); }
  switchTab(url) { return this.send('App.callWxMethod', { method: 'switchTab', args: [{ url: url }] }); }
  pageData(page) { return this.send('Page.getData', { id: page.pageId, path: page.path }); }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const client = await new Client(WS).connect();
  console.log('已连接 IDE 自动化桥: ' + WS);

  try { await client.send('App.enableLog'); } catch (e) { console.log('enableLog 失败(忽略): ' + e.message); }

  const problems = [];
  // 截图先攒在内存里，run 完统一落盘：
  // 往项目目录写文件会触发 IDE 的 onFileChange 重编译，页面当场被销毁，截出来是空白图
  const shots = [];

  for (const item of PAGES) {
    const label = item.path;
    let page = null;

    // 切页：最多重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await client.switchTab(item.path);
        await wait(4000);
        page = await client.currentPage();
        if (page && norm(page.path) === norm(item.path)) break;
        console.log('  ' + label + ' 第 ' + attempt + ' 次切换未到位，当前 ' + (page ? page.path : 'null'));
      } catch (err) {
        console.log('  ' + label + ' 第 ' + attempt + ' 次切换异常: ' + err.message);
      }
      await wait(1500);
    }

    if (!page || norm(page.path) !== norm(item.path)) {
      problems.push('切页失败: ' + label + ' → ' + (page ? page.path : 'null'));
      continue;
    }

    // 页面数据
    let data = null;
    try {
      const res = await client.pageData(page);
      data = (res && res.data) || null;
    } catch (err) {
      console.log('  提示: 页面数据读取失败（页面已重建）: ' + err.message);
    }

    if (data && data.loading) problems.push(label + ' 仍在 loading');
    if (data && data.loadError) problems.push(label + ' 数据错误: ' + data.loadError);

    // 截图
    let file = null;
    try {
      const shot = await client.screenshot();
      shots.push({ name: item.name + '.png', data: Buffer.from(shot.data, 'base64') });
      file = path.join(OUT, item.name + '.png');
      const size = shots[shots.length - 1].data.length;
      if (!size) problems.push(label + ' 截图为空');
      console.log('OK  ' + label + '  截图 ' + size + ' bytes');
    } catch (err) {
      problems.push(label + ' 截图失败: ' + err.message);
      console.log('FAIL ' + label + '  截图失败: ' + err.message);
    }

    if (data) {
      console.log('    ' + JSON.stringify({
        hero: data.hero ? data.hero.name + ' ' + (data.hero.priceText || '') : undefined,
        priceText: data.priceText,
        window: data.window ? data.window.dateText : undefined,
        trendPoints: data.trend && data.trend.points ? data.trend.points.length : undefined,
        notices: Array.isArray(data.notices) ? data.notices.length : undefined,
        market: data.market ? data.market.name + ' ' + (data.market.priceText || '') : undefined,
        marketPoints: data.market && data.market.points ? data.market.points.length : undefined,
        history: Array.isArray(data.history) ? data.history.length : undefined,
        region: data.region ? data.region.fullName : undefined,
        target: data.targetText
      }));
    }
  }

  // 统一落盘
  shots.forEach(function (s) {
    fs.writeFileSync(path.join(OUT, s.name), s.data);
  });

  console.log('\n--- 运行时事件 (' + client.events.length + ' 条) ---');
  client.events.slice(0, 40).forEach(function (e) {
    console.log('  ' + e.method + ': ' + JSON.stringify(e.params).slice(0, 300));
  });

  const exceptions = client.events.filter(function (e) {
    return e.method === 'App.exceptionThrown' ||
      (e.method === 'App.logAdded' && e.params && e.params.type === 'error');
  });
  if (exceptions.length) problems.push('捕获到 ' + exceptions.length + ' 条运行异常');

  console.log('\n--- 问题 ---');
  console.log(problems.length ? problems.join('\n') : '(无)');

  client.ws.close();
  process.exit(problems.length ? 1 : 0);
})().catch(function (err) {
  console.error('验证脚本异常:', err && err.message ? err.message : err);
  process.exit(2);
});
