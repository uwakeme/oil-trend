/**
 * 生成「提交开发版本」表单的必填项清单
 *
 * 背景：公众平台「版本管理 → 开发版本 → 提交审核」那张表有七八个必填/选填项，
 * 每次发版都要对着空表单回忆一遍。这里把它一次性列清楚，
 * 发完版直接照着填，别漏项。
 *
 * 用法：
 *   node scripts/release-form.js                      # 用当前 HEAD 与上一个 tag
 *   node scripts/release-form.js --version 1.0.2      # 指定版本
 *   node scripts/release-form.js --desc "一句话说明"   # 覆盖版本描述草稿
 *   node scripts/release-form.js --out docs/release-form-1.0.2.md
 *
 * 输出是 Markdown：既能贴在回复里，也能写进 GitHub Actions 的 summary。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (err) {
    return '';
  }
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

/** 提交标题里的约定式前缀：提交信息是给开发看的，版本描述是给审核与用户看的 */
function stripPrefix(subject) {
  return String(subject || '')
    .replace(/^(feat|fix|docs|refactor|perf|test|style|build|chore|ci)(\([^)]*\))?!?:\s*/, '')
    .trim();
}

/** 上一个 tag：版本描述要写「这一版改了什么」，得有个对比基准 */
function previousTag(version) {
  const tags = git(['tag', '--list', '--sort=-creatordate']).split('\n').filter(Boolean);
  for (let i = 0; i < tags.length; i++) {
    if (tags[i] !== version && tags[i].indexOf('v') === 0) return tags[i];
  }
  return '';
}

/** 隐私相关：用了哪些需要申报的接口、用途文案是什么 */
function privacyInfo() {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const infos = appJson.requiredPrivateInfos || [];
  const scopes = (appJson.permission || {})['scope.userLocation'];
  return {
    infos: infos,
    locationDesc: (scopes && scopes.desc) || '',
    hasLocation: infos.indexOf('getLocation') >= 0
  };
}

/** 截图素材：图片预览最多 10 张，核心页面优先 */
function screenshots() {
  const dir = path.join(ROOT, 'docs', 'screenshots');
  if (!fs.existsSync(dir)) return [];
  const core = ['01-price-home.png', '02-trend.png', '03-notice.png', '04-global.png', '05-alert.png'];
  const all = fs.readdirSync(dir).filter(function (f) { return /\.png$/i.test(f); });
  const picked = core.filter(function (f) { return all.indexOf(f) >= 0; });
  return {
    core: picked,
    extra: all.filter(function (f) { return picked.indexOf(f) < 0; })
  };
}

function main() {
  const version = (argOf('--version') || git(['describe', '--tags', '--exact-match', 'HEAD']) || '').replace(/^v/, '');
  if (!version) {
    console.error('定不出版本号：用 --version 指定，或在打了 tag 的提交上跑。');
    process.exit(1);
  }
  const since = previousTag('v' + version);
  const range = since ? since + '..v' + version : 'v' + version;
  const subjects = git(['log', range, '--pretty=%s']).split('\n').filter(Boolean);
  const drafts = subjects.map(stripPrefix).filter(Boolean);
  const descOverride = argOf('--desc');
  const desc = (descOverride || drafts.join('；') || ('版本 ' + version)).slice(0, 200);
  const privacy = privacyInfo();
  const shots = screenshots();

  const lines = [];
  lines.push('# 提交开发版本 ' + version + ' · 表单必填项');
  lines.push('');
  lines.push('| 表单项 | 填什么 | 依据 |');
  lines.push('| --- | --- | --- |');
  lines.push('| 版本描述（必填，≤200 字） | ' + desc + ' | ' +
    (since ? '本次发布 ' + since + ' → v' + version + ' 的 ' + subjects.length + ' 个提交' : '本次发布') + ' |');
  lines.push('| 图片预览（选填，最多 10 张） | ' +
    (shots.core.length ? '建议这 ' + shots.core.length + ' 张：' + shots.core.join('、') : '不传') +
    ' | docs/screenshots/ 里的核心页面截图 |');
  lines.push('| 视频预览（选填，1 个 mp4 ≤20M） | 不传 | 仓库里没有演示视频素材 |');
  lines.push('| 测试账号（必选） | 无需登录账号即可使用 | 五个页面都不需要登录；' +
    '登录只用于把提醒规则绑到 openid，核心功能不受影响 |');
  lines.push('| 小程序订单中心 path（选填） | 留空 | 本项目没有交易与订单 |');
  lines.push('| 审核加急（选填） | 不加急 | |');
  lines.push('| 用户隐私保护指引（必选） | ' +
    (privacy.hasLocation ? '采集用户隐私' : '未采集用户隐私') +
    ' | ' + (privacy.hasLocation ? '用了 wx.getLocation（' + privacy.infos.join('、') + '）' : '没有声明隐私接口') + ' |');
  if (privacy.hasLocation) {
    lines.push('| 隐私指引要申报的项 | 位置信息 —— ' + privacy.locationDesc +
      ' | 公众平台「设置 → 用户隐私保护指引」必须与 app.json 的 permission.scope.userLocation.desc 一致 |');
  }
  lines.push('| 服务类目 | 沿用后台已配置的类目 | 类目在公众平台「设置 → 基本设置」里配 |');
  lines.push('');
  lines.push('## 版本描述草稿的来源');
  lines.push('');
  if (subjects.length) {
    subjects.forEach(function (s) { lines.push('- ' + s); });
  } else {
    lines.push('- （没有可比对的提交）');
  }
  lines.push('');
  lines.push('> 草稿是从提交标题拼的，**审核与用户看的是这句** —— 提交前建议改成用户视角的一句话。');
  lines.push('');

  const text = lines.join('\n');
  const out = argOf('--out');
  if (out) {
    const file = path.isAbsolute(out) ? out : path.join(ROOT, out);
    fs.writeFileSync(file, text, 'utf8');
    console.log('已写入 ' + file);
  }
  console.log(text);
}

main();
