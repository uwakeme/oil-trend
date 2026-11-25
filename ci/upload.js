/**
 * 上传小程序包到微信公众平台（开发版本）
 *
 * 干什么：
 *   用微信官方 miniprogram-ci 把当前仓库的小程序代码打包上传到公众平台，
 *   传上去的版本落在「版本管理 → 开发版本」，之后人工提交审核、发布。
 *
 * 为什么不用开发者工具 CLI：
 *   scripts/preview-qr.js 走的是 IDE 的 cli.bat —— 要求 IDE 开着、已登录，
 *   CI 上跑不了。miniprogram-ci 不依赖 IDE，用「上传密钥」直接传。
 *
 * ⚠️ 自动化到哪一步（别误会）：
 *   ✅ 自动上传代码（开发版本）—— 本脚本做完这一步
 *   ❌ 自动提交审核 / 自动发布 —— miniprogram-ci 没有这两个接口；
 *      微信的 wxa/commit（提交审核）与 wxa/release（发布）只对**第三方平台**开放，
 *      个人主体小程序只能去公众平台后台人工点。
 *
 * 配置（环境变量）：
 *   WX_APP_ID                 正式 AppID。CI：仓库 secret；本地：读 project.private.config.json
 *   WX_UPLOAD_PRIVATE_KEY     上传密钥内容（PEM）。CI：仓库 secret
 *   WX_UPLOAD_PRIVATE_KEY_PATH  上传密钥文件路径（与上面二选一）
 *   WX_VERSION                版本号，如 0.2.0；不给则从 git tag 推
 *   WX_UPLOAD_DESC            上传描述；不给则自动拼「版本号 · 短 SHA · 提交标题」
 *   WX_UPLOAD_ROBOT           CI 编号 1~30，默认 1
 *
 * 用法：
 *   node ci/upload.js              # 真上传
 *   node ci/upload.js --dry-run    # 只检查配置能不能用，不上传
 *
 * 密钥从哪来：
 *   公众平台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成上传密钥（下载 private.key）。
 *   ⚠️ 那一页的「IP 白名单」要留空：GitHub runner 的出口 IP 不固定，填了就传不上去。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ci = require('miniprogram-ci');

const ROOT = path.resolve(__dirname, '..');

function die(msg, hints) {
  console.error('✗ ' + msg);
  (hints || []).forEach(function (h) { console.error('  · ' + h); });
  process.exit(1);
}

/** 读 AppID：环境变量优先，其次本地私有配置（真实 AppID 不入库） */
function resolveAppid() {
  const fromEnv = (process.env.WX_APP_ID || '').trim();
  if (fromEnv) return fromEnv;

  const privFile = path.join(ROOT, 'project.private.config.json');
  if (fs.existsSync(privFile)) {
    try {
      const json = JSON.parse(fs.readFileSync(privFile, 'utf8'));
      if (json.appid && json.appid !== 'touristappid') return json.appid;
    } catch (err) {
      // 私有配置坏了就当没有，往下走报错提示
    }
  }

  die('拿不到正式 AppID', [
    'CI：给仓库加 secret WX_APP_ID（公众平台 → 开发管理 → 开发设置 → AppID）',
    '本地：把 AppID 写进 project.private.config.json（该文件不入库）'
  ]);
}

/** 读上传密钥：文件路径优先，其次环境变量里的 PEM 内容 */
function resolvePrivateKey() {
  const keyPath = (process.env.WX_UPLOAD_PRIVATE_KEY_PATH || '').trim();
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8');
  }
  const inline = (process.env.WX_UPLOAD_PRIVATE_KEY || '').trim();
  if (inline) {
    // secret 里手写成字面换行符的也认，省得贴密钥时还得转真实换行
    const NL = String.fromCharCode(10);
    const BS = String.fromCharCode(92);
    return inline.split(BS + 'r' + NL).join(NL).split(BS + 'n').join(NL);
  }

  die('拿不到上传密钥', [
    '公众平台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成上传密钥（下载 private.key）',
    'CI：把 private.key 的内容存成仓库 secret WX_UPLOAD_PRIVATE_KEY',
    '本地：把密钥放磁盘并设 WX_UPLOAD_PRIVATE_KEY_PATH'
  ]);
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
  } catch (err) {
    return '';
  }
}

/**
 * 版本号必须是三段数字（微信只认 "1.0.0" 这种）。
 * tag 上的 v 前缀、段数不足，都在这里被规整掉。
 */
function normalizeVersion(raw) {
  const cleaned = String(raw || '').trim().replace(/^[vV]/, '');
  const parts = cleaned.split('.').filter(function (p) { return /^\d+$/.test(p); });
  if (!parts.length) return '';
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

function resolveVersion() {
  const explicit = normalizeVersion(process.env.WX_VERSION);
  if (explicit) return explicit;

  // 当前提交正好是个 tag：就用它（推 tag 发版的常规路径）
  const exact = normalizeVersion(git(['describe', '--tags', '--exact-match', 'HEAD']));
  if (exact) return exact;

  // 没有精确 tag：拿最近一个 tag 的主次版本号 + CI 运行号拼一版
  const last = normalizeVersion(git(['describe', '--tags', '--abbrev=0']));
  const run = (process.env.GITHUB_RUN_NUMBER || '').trim();
  if (last && /^\d+$/.test(run)) {
    const parts = last.split('.');
    return parts[0] + '.' + parts[1] + '.' + run;
  }

  die('推不出版本号', [
    '打个 tag 再推：git tag v0.2.0 && git push origin v0.2.0',
    '或直接给环境变量：WX_VERSION=0.2.0'
  ]);
}

function resolveDesc(version) {
  const explicit = (process.env.WX_UPLOAD_DESC || '').trim();
  if (explicit) return explicit.slice(0, 60);

  const parts = [version];
  const sha = git(['rev-parse', '--short', 'HEAD']);
  const subject = git(['log', '-1', '--pretty=%s']);
  if (sha) parts.push(sha);
  if (subject) parts.push(subject);
  return parts.join(' · ').slice(0, 60);
}

function resolveRobot() {
  const raw = (process.env.WX_UPLOAD_ROBOT || '').trim();
  const num = Number(raw || '1');
  if (!Number.isInteger(num) || num < 1 || num > 30) {
    die('WX_UPLOAD_ROBOT 必须是 1~30 的整数，现在拿到的是「' + raw + '」', []);
  }
  return num;
}

/** 上传失败时把常见原因翻译成人话 */
function hintsFor(msg) {
  const text = String(msg || '');
  const hints = [];
  if (/ip|白名单|whitelist/i.test(text)) {
    hints.push('IP 白名单拦了：公众平台「开发设置 → 小程序代码上传」的 IP 白名单要留空，GitHub runner 的出口 IP 不固定');
  }
  if (/sign|密钥|key/i.test(text)) {
    hints.push('上传密钥与 AppID 不匹配：确认 secret 里的密钥就是在**这个 AppID**下生成的');
  }
  if (/size|package|体积|2MB|超过/i.test(text)) {
    hints.push('主包超过 2MB：检查新加的目录有没有进 project.config.json 的 packOptions.ignore');
  }
  if (/version|版本/i.test(text)) {
    hints.push('版本号格式不对：必须是三段数字，如 0.2.0');
  }
  if (!hints.length) {
    hints.push('本地先跑 node ci/upload.js --dry-run 验证配置，再看这一行原始错误');
  }
  return hints;
}

async function main() {
  const dryRun = process.argv.indexOf('--dry-run') >= 0;

  const appid = resolveAppid();
  const privateKey = resolvePrivateKey();
  const version = resolveVersion();
  const desc = resolveDesc(version);
  const robot = resolveRobot();

  console.log('AppID   : ' + appid);
  console.log('版本号  : ' + version);
  console.log('描述    : ' + desc);
  console.log('CI 编号 : ' + robot);
  console.log('工程目录: ' + ROOT);

  if (dryRun) {
    console.log('');
    console.log('--dry-run：配置齐全，未上传。');
    return;
  }

  const project = new ci.Project({
    appid: appid,
    type: 'miniProgram',
    projectPath: ROOT,
    privateKey: privateKey
    // 不传 packOptions / ignores：打包要排除的目录统一由
    // project.config.json 的 packOptions.ignore 管，别在这里另写一份 ——
    // 两份清单迟早对不上，传上去的包就会把源码和服务端代码一起带上。
  });

  try {
    await ci.upload({
      project: project,
      version: version,
      desc: desc,
      robot: robot,
      // 编译设置直接取 project.config.json 的 setting：
      // 上传的那一版与开发者工具里点「上传」用的是同一套配置，不另写一份。
      setting: { useProjectConfig: true },
      onProgressUpdate: function (task) {
        if (task && task.message) console.log('  · ' + task.message);
      }
    });
  } catch (err) {
    const msg = (err && (err.message || err.errMsg)) || String(err);
    die('上传失败：' + msg, hintsFor(msg));
    return;
  }

  console.log('');
  console.log('✓ 上传成功，开发版本：' + version);
  console.log('下一步：公众平台 → 版本管理 → 开发版本 → 提交审核 → 审核通过后发布');
}

main().catch(function (err) {
  die('脚本异常：' + ((err && err.message) || err), []);
});
