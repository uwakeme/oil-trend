/**
 * WXML / WXSS / JS 静态检查器
 *
 * 模拟器跑起来之前，先用静态检查把大部分低级问题抓出来：
 *   1. usingComponents 指向的组件文件是否存在
 *   2. WXML 里引用的本地资源（/assets/...）是否存在
 *   3. {{ }} 绑定引用的字段是否在页面 data / 组件 properties 中声明过
 *   4. bindtap 等事件绑定的处理函数是否在对应 JS 里存在
 *   5. WXML 里用到的 class 是否在 wxss 或共享样式里有定义
 *   6. WXML 标签是否闭合
 *
 * 用法：node scripts/lint-wxml.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const warnings = [];

function read(abs) { return fs.readFileSync(abs, 'utf8'); }

function listFiles(dir, filter, acc) {
  acc = acc || [];
  if (!fs.existsSync(dir)) return acc;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    if (entry.name === 'node_modules' || entry.name === '.tooling' || entry.name === '.git') return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, filter, acc);
    else if (filter(entry.name)) acc.push(full);
  });
  return acc;
}

/* ---------- 读取页面的 data / properties / methods ---------- */

function collectScript(wxmlAbs) {
  const jsAbs = wxmlAbs.replace(/\.wxml$/, '.js');
  const result = { keys: new Set(), methods: new Set(), hasJs: false };
  if (!fs.existsSync(jsAbs)) return result;
  result.hasJs = true;
  const src = read(jsAbs);

  // data: { ... } 顶层 key
  const dataIdx = src.indexOf('data:');
  if (dataIdx >= 0) {
    const chunk = src.slice(dataIdx, dataIdx + 5000);
    const keyRe = /^\s{2,8}([A-Za-z_$][\w$]*)\s*:/gm;
    let m;
    while ((m = keyRe.exec(chunk))) result.keys.add(m[1]);
  }

  // properties: { name: { ... } } —— 组件属性也可以在 WXML 里绑定
  const propIdx = src.indexOf('properties:');
  if (propIdx >= 0) {
    const chunk = src.slice(propIdx, propIdx + 3000);
    const keyRe = /^\s{4,8}([A-Za-z_$][\w$]*)\s*:\s*\{/gm;
    let m;
    while ((m = keyRe.exec(chunk))) result.keys.add(m[1]);
  }

  // methods: { name(...) { } }
  const methodRe = /^\s{2,8}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  let mm;
  while ((mm = methodRe.exec(src))) result.methods.add(mm[1]);
  return result;
}

/* ---------- 解析 WXML ---------- */

function parseWxml(abs) {
  const src = read(abs);
  const tags = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  const stack = [];
  // WXML 里这些标签不需要闭合（注意：br / hr 不是 WXML 内置标签，不能用！）
  const VOID = ['image', 'input', 'icon', 'import', 'include', 'wxs'];
  let m;
  while ((m = tagRe.exec(src))) {
    const closing = m[1] === '/';
    const name = m[2];
    const attrs = m[3] || '';
    const selfClose = m[4] === '/';
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        problems.push(path.relative(ROOT, abs).replace(/\\/g, '/') +
          ': 标签闭合不匹配，期望 </' + open + '>，实际 </' + name + '>');
      }
    } else if (!selfClose && VOID.indexOf(name) < 0) {
      stack.push(name);
    }
    tags.push({ name: name, attrs: attrs, selfClose: selfClose });
  }
  if (stack.length) {
    problems.push(path.relative(ROOT, abs).replace(/\\/g, '/') + ': 有未闭合标签 ' + stack.join(', '));
  }
  return { src: src, tags: tags };
}

/**
 * WXML 内置标签白名单。
 * 自定义组件（usingComponents 里声明的）不在表里，由调用方额外放行。
 * br / hr 不在表里 —— WXML 没有它们，写上去会被当成自定义组件，
 * 解析器接着报 "unexpected end tag"。
 */
const WXML_TAGS = [
  'view', 'scroll-view', 'swiper', 'swiper-item', 'movable-view', 'movable-area',
  'cover-view', 'cover-image', 'icon', 'text', 'rich-text', 'progress', 'button',
  'checkbox', 'checkbox-group', 'form', 'input', 'label', 'picker', 'picker-view',
  'picker-view-column', 'radio', 'radio-group', 'slider', 'switch', 'textarea',
  'navigator', 'functional-page-navigator', 'audio', 'image', 'video', 'camera',
  'live-player', 'live-pusher', 'map', 'canvas', 'web-view', 'block', 'template',
  'import', 'include', 'wxs', 'slot', 'navigation-bar', 'page-meta',
  'page-container', 'root-portal', 'match-media', 'ad', 'ad-custom',
  'official-account', 'open-data'
];

function attrValue(attrs, key) {
  const re = new RegExp(key + '="([^"]*)"');
  const m = re.exec(attrs);
  return m ? m[1] : null;
}

/* ---------- 主流程 ---------- */

const wxmlFiles = listFiles(ROOT, function (n) { return n.endsWith('.wxml'); })
  .filter(function (f) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    return rel.indexOf('node_modules') < 0 && rel.indexOf('.tooling') < 0;
  });

const sharedClasses = new Set();
['styles/components.wxss', 'styles/tokens.wxss'].forEach(function (rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const css = read(abs);
  const re = /\.([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) sharedClasses.add(m[1]);
});

wxmlFiles.forEach(function (wxmlAbs) {
  const rel = path.relative(ROOT, wxmlAbs).replace(/\\/g, '/');
  const parsed = parseWxml(wxmlAbs);
  const script = collectScript(wxmlAbs);

  const jsonAbs = wxmlAbs.replace(/\.wxml$/, '.json');
  let using = {};
  if (fs.existsSync(jsonAbs)) {
    try { using = (JSON.parse(read(jsonAbs)).usingComponents) || {}; } catch (e) {
      problems.push(rel.replace(/\.wxml$/, '.json') + ': JSON 解析失败');
    }
  }

  Object.keys(using).forEach(function (name) {
    const p = using[name];
    if (p && p.charAt(0) === '/') {
      const abs = path.join(ROOT, p);
      if (!fs.existsSync(abs + '.wxml') && !fs.existsSync(path.join(abs, 'index.wxml'))) {
        problems.push(rel.replace(/\.wxml$/, '.json') + ': 组件 ' + name + ' 指向 ' + p + ' 但文件不存在');
      }
    }
  });

  const wxssAbs = wxmlAbs.replace(/\.wxml$/, '.wxss');
  const localClasses = new Set(sharedClasses);
  if (fs.existsSync(wxssAbs)) {
    const css = read(wxssAbs);
    const re = /\.([a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(css))) localClasses.add(m[1]);
  }

  // wx:for 的别名
  const forAliases = new Set();
  parsed.tags.forEach(function (tag) {
    if (attrValue(tag.attrs, 'wx:for')) {
      forAliases.add(attrValue(tag.attrs, 'wx:for-item') || 'item');
      forAliases.add(attrValue(tag.attrs, 'wx:for-index') || 'index');
    }
  });

  parsed.tags.forEach(function (tag) {
    const attrs = tag.attrs;

    /* 标签必须是 WXML 内置标签或已声明的自定义组件 */
    if (WXML_TAGS.indexOf(tag.name) < 0 && !using[tag.name]) {
      problems.push(rel + ': <' + tag.name + '> 不是 WXML 内置标签，也没在 usingComponents 里声明');
    }

    /* 资源引用（只校验不含 {{}} 的静态路径） */
    const src = attrValue(attrs, 'src');
    if (src && src.charAt(0) === '/' && src.indexOf('{{') < 0) {
      if (!fs.existsSync(path.join(ROOT, src))) {
        problems.push(rel + ': 资源不存在 ' + src);
      }
    }

    /* 数据绑定 */
    const bindingRe = /\{\{([^}]+)\}\}/g;
    let bm;
    while ((bm = bindingRe.exec(attrs))) {
      const expr = bm[1].trim();
      // 去掉前导的一元运算符与括号
      const cleaned = expr.replace(/^[!?:\s(]+/, '');
      const root = cleaned.split(/[.\s(\[]/)[0];
      if (!root) continue;
      if (/^\d/.test(root)) continue;
      if (forAliases.has(root)) continue;
      if (['true', 'false', 'null', 'undefined', 'this', 'index', 'item'].indexOf(root) >= 0) continue;
      if (script.keys.has(root)) continue;
      warnings.push(rel + ': 绑定字段 "' + root + '" 未在对应 JS 的 data / properties 中声明');
    }

    /* 事件处理函数 */
    const eventRe = /(?:bind|catch|capture-bind|capture-catch):?[a-zA-Z]+="([^"]+)"/g;
    let em;
    while ((em = eventRe.exec(attrs))) {
      const handler = em[1];
      if (!handler || handler.indexOf('.') >= 0) continue;
      if (script.methods.has(handler)) continue;
      if (using[tag.name]) continue;   // 自定义组件自身触发的事件不必在页面定义
      problems.push(rel + ': 事件 ' + handler + ' 在对应 JS 中没有对应的方法');
    }

    /* class 定义（先去掉 {{}} 表达式再拆词） */
    const cls = attrValue(attrs, 'class');
    if (cls) {
      const plain = cls.replace(/\{\{[^}]*\}\}/g, ' ');
      plain.split(/\s+/).forEach(function (name) {
        if (!name) return;
        if (localClasses.has(name)) return;
        warnings.push(rel + ': class "' + name + '" 没有对应的样式定义');
      });
    }
  });
});

console.log('检查 WXML 文件数: ' + wxmlFiles.length);
console.log('\n--- 错误 (' + problems.length + ') ---');
console.log(problems.length ? problems.join('\n') : '(无)');
console.log('\n--- 警告 (' + warnings.length + ') ---');
console.log(warnings.length ? warnings.join('\n') : '(无)');
process.exit(problems.length ? 1 : 0);
