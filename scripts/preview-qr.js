/**
 * 生成预览二维码
 *
 * 用法：
 *   node scripts/preview-qr.js wx<你的AppID>
 *   node scripts/preview-qr.js            # 用当前生效的 appid
 *
 * 做的事：
 *   1. 把 appid 写进 project.private.config.json（只写本地私有配置）
 *   2. 调开发者工具 CLI 上传预览包，把二维码输出到 docs/
 *
 * 注意：预览包是临时的，不会影响已发布版本。
 * 开发者工具必须先登录，否则平台会拒绝上传预览包。
 *
 * 环境变量：
 *   WX_DEVTOOLS       开发者工具 cli.bat 路径（默认取 Windows 常见安装位置）
 *   WX_DEVTOOLS_PORT  开发者工具服务端口（默认 9420，端口不对会自动纠正）
 *
 * 两个踩过的坑：
 *   1. CLI 上传失败时**退出码仍然是 0**，不能靠退出码判断成败 ——
 *      上传前先删掉旧的二维码文本，跑完没有新文件就当失败处理，
 *      否则会把上一份过期二维码当成新的用（换 AppID 时最容易中招）。
 *   2. 开发者工具的服务端口会变，重启 IDE 后常换一个。端口不对时 CLI 会
 *      回「IDE 已启动并在监听 http://127.0.0.1:XXXXX」，按它说的端口重试。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI_CANDIDATES = [
  process.env.WX_DEVTOOLS,
  'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat'
];

function findCli() {
  for (const p of CLI_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 读取当前生效的 appid。
 * 开发者工具会把 project.private.config.json 合并覆盖到 project.config.json 上，
 * 真实 AppID 放在私有配置里，公开仓库里就不留 AppID 了。
 */
function effectiveAppid() {
  const priv = path.join(ROOT, 'project.private.config.json');
  if (fs.existsSync(priv)) {
    const j = JSON.parse(fs.readFileSync(priv, 'utf8'));
    if (j.appid) return j.appid;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
  return cfg.appid;
}

function setAppid(appid) {
  // 只写本地私有配置：project.config.json 是入库文件，
  // 真实 AppID 放进去会被 GitHub 密钥扫描误报成密钥。
  const file = path.join(ROOT, 'project.private.config.json');
  if (!fs.existsSync(file)) {
    console.log('没有 project.private.config.json，无法写入 AppID');
    return;
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.appid = appid;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log('已写入 project.private.config.json → ' + appid);
}

function main() {
  const appid = process.argv[2];
  const cli = findCli();

  if (!cli) {
    console.error('找不到开发者工具 cli.bat。用环境变量 WX_DEVTOOLS 指定路径。');
    process.exit(1);
  }

  if (appid) {
    setAppid(appid);
  } else {
    const current = effectiveAppid();
    console.log('使用当前生效的 appid: ' + current);
    if (!current || current === 'touristappid') {
      console.error('当前是测试号，平台会拒绝上传预览包。');
      console.error('请传入正式 AppID：node scripts/preview-qr.js wx<你的AppID>');
      process.exit(1);
    }
  }

  const outDir = path.join(ROOT, 'docs');
  // --qr-output 要的是**文件路径**，传目录会报 EISDIR
  // 而且它写出来的是带 ANSI 颜色码的终端字符二维码，不是图片
  const qrText = path.join(outDir, 'preview-qr.txt');
  const qrFile = path.join(outDir, 'preview-qr.png');

  // 跑一次 CLI，返回 stdout 与 stderr 合并后的输出
  function runCli(port) {
    const res = spawnSync('cmd.exe', ['/c', cli, 'preview', '--project', ROOT, '--port', String(port), '--qr-output', qrText, '--lang', 'zh'], {
      encoding: 'utf8'
    });
    return { out: (res.stdout || '') + (res.stderr || ''), code: res.status };
  }

  // 上传前先删掉旧的二维码文本：CLI 上传失败时退出码也是 0，
  // 留着旧文件会被当成新上传的产物，换 AppID 时就会拿过期二维码当新的用。
  if (fs.existsSync(qrText)) fs.unlinkSync(qrText);

  let port = process.env.WX_DEVTOOLS_PORT || '9420';
  console.log('正在上传预览包…（首次会慢一些）');
  let result = runCli(port);

  // 服务端口会变（重启 IDE 后常换一个）。端口不对时 CLI 会回
  // 「IDE 已启动并在监听 http://127.0.0.1:XXXXX」，按它说的端口重试一次。
  const portInMsg = result.out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (portInMsg && portInMsg[1] !== String(port)) {
    console.log('开发者工具服务端口是 ' + portInMsg[1] + '，换端口重试…');
    port = portInMsg[1];
    result = runCli(port);
  }

  console.log(result.out);

  if (!fs.existsSync(qrText) || fs.statSync(qrText).size === 0) {
    console.error('预览包没有上传成功：没有生成新的二维码文本。');
    console.error('如果上面的输出里有「使用 AppID: xxx」，确认那是当前账号的 AppID；');
    console.error('常见原因：开发者工具未登录、AppID 不合法（测试号会被拒绝）、服务端口不对。');
    process.exit(1);
  }
  // 终端字符二维码 → 可扫码的 PNG
  try {
    const conv = execFileSync('python', [path.join(ROOT, 'scripts', 'qr-text-to-png.py'), qrText, qrFile], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(conv.trim());
    console.log('二维码文件：' + qrFile);
  } catch (err) {
    console.error('二维码转 PNG 失败：' + (err.stderr || err.message));
    console.log('原始终端二维码：' + qrText);
  }
}

main();
