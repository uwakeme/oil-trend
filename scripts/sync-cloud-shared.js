/**
 * 把 cloudfunctions/_shared/shared.js 同步到每个云函数目录。
 *
 * 小程序端与云函数端共用同一套调价时间线与地区价差规则，
 * 但云函数各自独立打包上传，不能跨目录 require，
 * 所以用这个脚本把共享代码复制过去。
 *
 * 用法：node scripts/sync-cloud-shared.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sharedDir = path.join(root, 'cloudfunctions', '_shared');
const sharedFile = path.join(sharedDir, 'shared.js');

const functionsDir = path.join(root, 'cloudfunctions');
const targets = fs.readdirSync(functionsDir).filter(function (name) {
  const full = path.join(functionsDir, name);
  return fs.statSync(full).isDirectory() && name !== '_shared';
});

if (!fs.existsSync(sharedFile)) {
  console.error('找不到共享文件：' + sharedFile);
  process.exit(1);
}

targets.forEach(function (name) {
  const dest = path.join(functionsDir, name, 'shared.js');
  fs.copyFileSync(sharedFile, dest);
  console.log('已同步 → ' + path.relative(root, dest));
});

console.log('共同步 ' + targets.length + ' 个云函数。');
