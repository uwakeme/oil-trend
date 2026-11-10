/**
 * 生成预览二维码
 *
 * 用法：
 *   node scripts/preview-qr.js wx<你的AppID>
 *   node scripts/preview-qr.js            # 用当前生效的 appid
 *
 * 做的事：
 *   1. 把 appid 写进 project.config.json 和 project.private.config.json
 *   2. 调开发者工具 CLI 上传预览包，把二维码输出到 docs/
 *
 * 注意：预览包是临时的，不会影响已发布版本。
 * 开发者工具必须先登录，否则平台会拒绝上传预览包。
 *
 * 环境变量：
 *   WX_DEVTOOLS  开发者工具 cli.bat 路径（默认取 Windows 常见安装位置）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
  ['project.config.json', 'project.private.config.json'].forEach(function (name) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) return;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.appid = appid;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    console.log('已写入 ' + name + ' → ' + appid);
  });
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
  console.log('正在上传预览包…（首次会慢一些）');
  try {
    const out = execFileSync('cmd.exe', ['/c', cli, 'preview', '--project', ROOT, '--port', '9420', '--qr-output', qrText, '--lang', 'zh'], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(out);
  } catch (err) {
    console.error('预览失败：');
    console.error(err.stdout || '');
    console.error(err.stderr || '');
    console.error('常见原因：开发者工具未登录，或 AppID 不合法（测试号会被拒绝）。');
    process.exit(1);
  }

  if (!fs.existsSync(qrText)) {
    console.log('没有生成二维码文本，检查上面的输出。');
    return;
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
