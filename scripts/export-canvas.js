/**
 * 图表画布导出脚本
 *
 * 背景：`App.captureScreenshot` 只截 DOM 层，不合成 canvas 图层，
 * 自动截图里图表区域必然是空白（见 docs/verification.md）。
 * 要拿到带曲线的成品图，得先把画布内容单独导出来，再贴回页面截图。
 *
 * 做法（与 docs/verification.md 记录的一致）：
 *   1. 临时给 components/trend-chart/index.js 注入导出钩子；
 *   2. 让 IDE 重新编译，在页面里跑 wx.canvasToTempFilePath → base64 → 写 storage；
 *   3. 从外部用 App.callWxMethod 调 getStorageSync 把 base64 取回来，落成 PNG + rect.json；
 *   4. 还原组件源码（脚本结束前一定会还原，避免临时代码留在仓库里）；
 *   5. 用 scripts/compose-screenshots.py 把画布贴回页面截图。
 *
 * 用法：
 *   cli.bat auto --project <path> --auto-port <port>     # 先起自动化服务
 *   node scripts/export-canvas.js                         # 端口用 AUTO_WS 覆盖
 *   python scripts/compose-screenshots.py
 *
 * 退出码：0 = 全部导出成功；1 = 有失败
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const COMPONENT = path.join(ROOT, 'components', 'trend-chart', 'index.js');
const WS = process.env.AUTO_WS || 'ws://127.0.0.1:9421';

const TARGETS = [
  { page: '/pages/index/index', file: 'canvas-home-mini' },
  { page: '/pages/trend/trend', file: 'canvas-trend' },
  { page: '/pages/global/global', file: 'canvas-global' }
];

const REQ_KEY = '__oil_export_req';
const DATA_KEY = '__oil_export_data';

/* ---------- ws 载入 ---------- */

function loadWs() {
  try { return require('ws'); } catch (e) {
    return require(path.join(ROOT, '.tooling', 'node_modules', 'ws'));
  }
}
const WebSocket = loadWs();

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- 自动化协议客户端 ---------- */

class Client {
  constructor(url) {
    this.url = url;
    this.callbacks = new Map();
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
        if (!msg.id) return;
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
  wxMethod(method, args) { return this.send('App.callWxMethod', { method: method, args: args || [] }); }
  getStorage(key) { return this.wxMethod('getStorageSync', [key]); }
  setStorage(key, data) { return this.wxMethod('setStorageSync', [key, data]); }
  reLaunch(url) { return this.wxMethod('reLaunch', [{ url: url }]); }
}

/* ---------- 临时钩子注入 ---------- */

const HOOK_FN = `
/* ===== 临时导出钩子（scripts/export-canvas.js 注入，脚本结束后自动移除） ===== */
function __oilChartExport(component, canvas) {
  try {
    var req = wx.getStorageSync('${REQ_KEY}');
    if (!req || !req.token || req.done) return;
    req.done = true;
    wx.setStorageSync('${REQ_KEY}', req);
    component.createSelectorQuery().select('#chartCanvas').boundingClientRect().exec(function (res) {
      var rect = res && res[0];
      if (!rect) {
        wx.setStorageSync('${DATA_KEY}', { token: req.token, error: '取不到画布位置' });
        return;
      }
      wx.canvasToTempFilePath({
        canvas: canvas,
        success: function (r) {
          wx.getFileSystemManager().readFile({
            filePath: r.tempFilePath,
            encoding: 'base64',
            success: function (f) {
              wx.setStorageSync('${DATA_KEY}', {
                token: req.token,
                id: 'chartCanvas',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                base64: f.data
              });
            },
            fail: function (e) {
              wx.setStorageSync('${DATA_KEY}', { token: req.token, error: 'readFile 失败 ' + JSON.stringify(e) });
            }
          });
        },
        fail: function (e) {
          wx.setStorageSync('${DATA_KEY}', { token: req.token, error: 'canvasToTempFilePath 失败 ' + JSON.stringify(e) });
        }
      });
    });
  } catch (e) {
    wx.setStorageSync('${DATA_KEY}', { token: (wx.getStorageSync('${REQ_KEY}') || {}).token, error: String(e) });
  }
}
/* ===== 临时导出钩子结束 ===== */
`;

function buildPatched(source) {
  let out = source;

  const queryAnchor = '      const query = this.createSelectorQuery();';
  if (out.indexOf(queryAnchor) === -1) throw new Error('注入锚点 1 未找到：createSelectorQuery');
  out = out.replace(queryAnchor, queryAnchor + '\n      const self = this;');

  const drawAnchor = '          chart.drawSeries(ctx, { width: width, height: height }, options);';
  if (out.indexOf(drawAnchor) === -1) throw new Error('注入锚点 2 未找到：drawSeries');
  out = out.replace(drawAnchor, drawAnchor + '\n          __oilChartExport(self, canvas);');

  // 钩子函数放在文件最前面（模块级）
  const head = 'const chart = require(\'../../utils/chart\');';
  if (out.indexOf(head) === -1) throw new Error('注入锚点 3 未找到：require chart');
  out = out.replace(head, head + '\n' + HOOK_FN);

  return out;
}

/* ---------- 主流程 ---------- */

(async function main() {
  const original = fs.readFileSync(COMPONENT, 'utf8');
  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    fs.writeFileSync(COMPONENT, original, 'utf8');
    console.log('已还原 components/trend-chart/index.js');
  }
  process.on('exit', restore);

  let client = null;
  try {
    fs.mkdirSync(OUT, { recursive: true });

    // 1. 注入钩子并让 IDE 重新编译
    fs.writeFileSync(COMPONENT, buildPatched(original), 'utf8');
    console.log('已注入临时导出钩子，等待 IDE 重新编译…');
    await wait(9000);

    client = await new Client(WS).connect();
    console.log('已连接 IDE 自动化桥: ' + WS);

    const results = [];

    for (const target of TARGETS) {
      const token = crypto.randomUUID();
      await client.setStorage(REQ_KEY, { token: token, done: false });
      await client.setStorage(DATA_KEY, null);

      // 重新拉起页面，触发组件 ready → 绘制 → 导出
      await client.reLaunch(target.page);
      await wait(3500);

      let payload = null;
      for (let i = 0; i < 20; i++) {
        // 自动化桥的返回值统一包了一层 { result: ... }，得拆开
        const raw = await client.getStorage(DATA_KEY);
        const value = raw && raw.result;
        if (value && value.token === token) { payload = value; break; }
        await wait(1000);
      }

      await client.setStorage(REQ_KEY, null);

      if (!payload) {
        results.push({ file: target.file, ok: false, error: '等待导出数据超时（页面没触发导出钩子）' });
        continue;
      }
      if (payload.error) {
        results.push({ file: target.file, ok: false, error: payload.error });
        continue;
      }

      const png = Buffer.from(payload.base64, 'base64');
      fs.writeFileSync(path.join(OUT, target.file + '.png'), png);
      // 紧凑单行格式，和仓库里已有的 rect.json 保持一致
      fs.writeFileSync(path.join(OUT, target.file + '.rect.json'), JSON.stringify({
        id: payload.id || 'chartCanvas',
        dataset: {},
        left: payload.left,
        right: payload.left + payload.width,
        top: payload.top,
        bottom: payload.top + payload.height,
        width: payload.width,
        height: payload.height
      }));

      results.push({
        file: target.file,
        ok: true,
        bytes: png.length,
        rect: payload.width + 'x' + payload.height + ' @ ' + payload.left + ',' + payload.top
      });
      console.log('OK  ' + target.file + '  ' + png.length + ' bytes  ' +
        payload.width + 'x' + payload.height + ' @ ' + payload.left + ',' + payload.top);
    }

    restore();
    if (client) client.ws.close();

    const failed = results.filter(function (r) { return !r.ok; });
    if (failed.length) {
      console.log('\n--- 失败 ---');
      failed.forEach(function (r) { console.log('  ' + r.file + ': ' + r.error); });
      process.exit(1);
    }
    console.log('\n画布导出完成，接下来跑 python scripts/compose-screenshots.py 合成。');
    process.exit(0);
  } catch (err) {
    restore();
    if (client) { try { client.ws.close(); } catch (e) { /* ignore */ } }
    console.error('导出失败:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
