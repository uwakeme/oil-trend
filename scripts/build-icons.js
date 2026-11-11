/**
 * 图标构建脚本
 *
 * 微信小程序 WXML 不支持内联 <svg>，所以把原型里的 SVG 精灵
 * 渲染成透明背景 PNG，用 <image> 组件引用。
 *
 * 用法：node scripts/build-icons.js
 * 依赖：本机安装的 Chrome（用于栅格化），无需 npm 包。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'icons');

/** 原型设计稿中的 SVG 精灵 */
const SPRITE = {
  fuel: '<path d="M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M3 21h14M7 7h6v5H7zM15 8h2l3 3v7a1.5 1.5 0 0 1-3 0v-4"/>',
  home: '<path d="M3 10.5 12 3l9 7.5M5.5 9v12h13V9M9 21v-7h6v7"/>',
  trend: '<path d="M4 19V5M4 19h16M7 15l4-5 3 3 5-7M16 6h3v3"/>',
  notice: '<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>',
  global: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/>',
  bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M9 21h6"/>',
  pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.7-1.6l.9-1.9-2.1-2.1-1.9.9a7 7 0 0 0-1.7-.7L10.5 2h-3l-.7 2a7 7 0 0 0-1.6.7l-1.9-.9-2.1 2.1.9 1.9a7 7 0 0 0-.7 1.7l-2 .7v3l2 .7a7 7 0 0 0 .7 1.6l-.9 1.9 2.1 2.1 1.9-.9a7 7 0 0 0 1.7.7l.7 2h3l.7-2a7 7 0 0 0 1.6-.7l1.9.9 2.1-2.1-.9-1.9a7 7 0 0 0 .7-1.7Z" transform="translate(2.5 0) scale(.8)"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'
};

/** 每个图标需要的颜色变体 */
const VARIANTS = [
  { file: 'home-muted', icon: 'home', color: '#929790' },
  { file: 'home-active', icon: 'home', color: '#142c23' },
  { file: 'trend-muted', icon: 'trend', color: '#929790' },
  { file: 'trend-active', icon: 'trend', color: '#142c23' },
  { file: 'notice-muted', icon: 'notice', color: '#929790' },
  { file: 'notice-active', icon: 'notice', color: '#142c23' },
  { file: 'global-muted', icon: 'global', color: '#929790' },
  { file: 'global-active', icon: 'global', color: '#142c23' },
  { file: 'bell-muted', icon: 'bell', color: '#929790' },
  { file: 'bell-active', icon: 'bell', color: '#142c23' },
  { file: 'bell-amber', icon: 'bell', color: '#e9a928' },
  { file: 'bell-white', icon: 'bell', color: '#fffdf6' },
  { file: 'bell-green', icon: 'bell', color: '#137a52' },
  { file: 'fuel-amber', icon: 'fuel', color: '#e9a928' },
  { file: 'pin-ink', icon: 'pin', color: '#17231e' },
  { file: 'chevron-muted', icon: 'chevron', color: '#6f7771' },
  { file: 'settings-ink', icon: 'settings', color: '#17231e' },
  { file: 'check-green', icon: 'check', color: '#137a52' },
  { file: 'check-white', icon: 'check', color: '#ffffff' },
  { file: 'info-amber', icon: 'info', color: '#7f6b39' },
  { file: 'arrow-muted', icon: 'arrow', color: '#6f7771' },
  { file: 'target-green', icon: 'target', color: '#137a52' },
  { file: 'target-amber', icon: 'target', color: '#79510a' }
];

const SIZE = 48;      // CSS 像素
const SCALE = 2;      // 2 倍图，输出 96x96

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildHtml(icon, color) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;}
svg{display:block;}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"
  fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  ${SPRITE[icon]}
</svg></body></html>`;
}

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('找不到 Chrome / Edge，无法栅格化图标。');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oil-icons-'));

  VARIANTS.forEach((variant) => {
    const htmlPath = path.join(tmpDir, variant.file + '.html');
    const pngPath = path.join(OUT_DIR, variant.file + '.png');
    fs.writeFileSync(htmlPath, buildHtml(variant.icon, variant.color), 'utf8');
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--force-device-scale-factor=' + SCALE,
      '--window-size=' + SIZE + ',' + SIZE,
      '--screenshot=' + pngPath,
      'file:///' + htmlPath.replace(/\\/g, '/')
    ], { stdio: 'ignore' });
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png'));
  console.log('已生成 ' + files.length + ' 个图标到 ' + OUT_DIR);
}

main();
