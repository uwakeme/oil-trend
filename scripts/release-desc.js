/**
 * 生成「提交开发版本」用的版本描述
 *
 * 用途：公众平台「版本管理 → 开发版本 → 提交审核」那张表里，
 * **版本描述**是唯一每次都要写、且写错会被打回的必填项。
 * 这个脚本从上一个 tag 到这一版的提交标题拼一版草稿，省得凭空想。
 *
 * 用法：
 *   node scripts/release-desc.js                     # 用当前 HEAD 与上一个 tag
 *   node scripts/release-desc.js --version 1.0.2     # 指定版本
 *   node scripts/release-desc.js --desc "写好的描述"  # 直接用给定的描述
 *
 * ⚠️ 草稿是提交标题拼的，**给开发看的**。
 *   提交前要改成**用户视角的一句话** —— 审核员和用户看的是这句。
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

/** 提交标题里的约定式前缀 */
function stripPrefix(subject) {
  return String(subject || '')
    .replace(/^(feat|fix|docs|refactor|perf|test|style|build|chore|ci)(\([^)]*\))?!?:\s*/, '')
    .trim();
}

/** 上一个 tag：这一版改了什么，得有对比基准 */
function previousTag(version) {
  const tags = git(['tag', '--list', '--sort=-creatordate']).split('\n').filter(Boolean);
  for (let i = 0; i < tags.length; i++) {
    if (tags[i] !== version && tags[i].indexOf('v') === 0) return tags[i];
  }
  return '';
}

function main() {
  const version = (argOf('--version') || git(['describe', '--tags', '--exact-match', 'HEAD']) || '').replace(/^v/, '');
  const override = argOf('--desc');
  if (override) {
    console.log(override.slice(0, 200));
    return;
  }
  if (!version) {
    console.error('定不出版本号：用 --version 指定，或在打了 tag 的提交上跑。');
    process.exit(1);
  }
  const since = previousTag('v' + version);
  const range = since ? since + '..v' + version : 'v' + version;
  const subjects = git(['log', range, '--pretty=%s']).split('\n').filter(Boolean);
  const drafts = subjects.map(stripPrefix).filter(Boolean);
  console.log((drafts.join('；') || ('版本 ' + version)).slice(0, 200));
}

main();
