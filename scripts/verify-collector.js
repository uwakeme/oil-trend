/**
 * 采集器验证脚本：node scripts/verify-collector.js [--live]
 *
 * 两部分：
 *   1. fixture 回归（默认）：用 2026-11-12 真实抓取的三个省页快照
 *      （scripts/fixtures/qiyoujiage-*.html）验证解析器，价格与
 *      data/reference-prices.js（独立来源）逐值比对；另有一组构造用例
 *      覆盖下调/搁浅/幅度缺失/跨年/注释干扰等边界。
 *   2. 真实抓取（--live）：现抓北京/陕西/云南三省页验证解析仍然成立。
 *      只断言结构与数值区间，不与 reference 比对 —— 调价后挂牌价会变。
 *
 * 退出码：0 = 全部通过；1 = 有用例失败
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const { REFERENCE_PRICES } = require(path.join(ROOT, 'data', 'reference-prices'));
const { REGIONS } = require(path.join(ROOT, 'data', 'regions'));

const IMPLS = [
  ['自建后端', require(path.join(ROOT, 'server', 'src', 'services', 'sources'))]
];

// fixture 抓取于 2026-11-12，固定「今天」让年份推断不随跑脚本的日期漂移
const NOW = Date.UTC(2026, 10, 12, 4); // 2026-11-12 12:00 UTC+8

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('✓ ' + name);
  } catch (e) {
    failures++;
    console.error('✗ ' + name + '：' + e.message);
  }
}

/* ---------- 构造用例的页面拼装 ---------- */

const DEFAULT_DLS =
  '<dl><dt>北京92#汽油</dt><dd>8.89</dd></dl>' +
  '<dl><dt>北京95#汽油</dt><dd>9.46</dd></dl>' +
  '<dl><dt>北京98#汽油</dt><dd>10.96</dd></dl>' +
  '<dl><dt>北京0#柴油</dt><dd>8.65</dd></dl>';

function page(trendHtml, dls) {
  return '<div id="youjiaCont"><div id="youjia">' + (dls || DEFAULT_DLS) + '</div>' + (trendHtml || '') + '</div>';
}

function trendDiv(text) {
  return '<div style="border:solid 1px #EA5146; background-color:#F2F7FC;">' + text + '</div>';
}

const EXPECTED_TREND = {
  date: '2026-11-12',
  time: '24:00',
  direction: 'up',
  changeTon: 90,
  literMin: 0.07,
  literMax: 0.08
};

/* ---------- 用例 ---------- */

function runSuite(label, sources) {
  const parse = (html, now) => sources.PARSERS.qiyoujiageRegion(html, now === undefined ? NOW : now);

  check(label + ' 来源配置：qiyoujiage 已启用且为 price 类型', () => {
    const s = sources.SOURCES.find(x => x.id === 'qiyoujiage');
    assert(s, '缺少 qiyoujiage 来源');
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.kind, 'price');
    assert.strictEqual(typeof sources.PARSERS[s.parser], 'function');
    assert(s.url.endsWith('/'), 'url 要以 / 结尾，拼接地区页用');
  });

  for (const [regionName, slug] of [['北京', 'beijing'], ['陕西', 'shanxi-3'], ['云南', 'yunnan']]) {
    check(label + ' fixture ' + regionName + '：四油品价格与独立来源一致', () => {
      const html = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'qiyoujiage-' + slug + '.html'), 'utf8');
      const r = parse(html);
      assert(r, '解析结果为 null');
      assert.deepStrictEqual(r.prices, REFERENCE_PRICES[regionName]);
    });
    check(label + ' fixture ' + regionName + '：预测字段', () => {
      const html = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'qiyoujiage-' + slug + '.html'), 'utf8');
      const t = parse(html).trend;
      assert(t, 'trend 为 null');
      for (const k of Object.keys(EXPECTED_TREND)) {
        assert.strictEqual(t[k], EXPECTED_TREND[k], k + ' 不符：' + t[k] + ' ≠ ' + EXPECTED_TREND[k]);
      }
    });
  }

  check(label + ' 空页面 / 缺油品 / 坏价格 / 超区间 → null（转人工）', () => {
    assert.strictEqual(parse(''), null);
    assert.strictEqual(parse('<div id="youjia"><dl><dt>92#汽油</dt><dd>8.89</dd></dl></div>'), null);
    assert.strictEqual(parse(page('', '<dl><dt>92#汽油</dt><dd>abc</dd></dl>' + DEFAULT_DLS.slice(DEFAULT_DLS.indexOf('<dl><dt>北京95')))), null);
    assert.strictEqual(parse(page('', DEFAULT_DLS.replace('8.89', '99'))), null);
  });

  check(label + ' 90# 不干扰 0#（按完整标号匹配，不按子串）', () => {
    const dls = '<dl><dt>北京90#汽油</dt><dd>7.50</dd></dl>' + DEFAULT_DLS;
    const r = parse(page('', dls));
    assert.deepStrictEqual(Object.keys(r.prices).sort(), ['0', '92', '95', '98']);
    assert.strictEqual(r.prices['0'], 8.65);
  });

  check(label + ' 号字写法（92号汽油）也能认', () => {
    const dls = DEFAULT_DLS.replace(/#/g, '号');
    const r = parse(page('', dls));
    assert.strictEqual(r.prices['92'], 8.89);
    assert.strictEqual(r.prices['0'], 8.65);
  });

  check(label + ' 下调：吨幅带负号，升区间无符号', () => {
    const t = parse(page(trendDiv('下次油价11月24日24时调整<br/><span>目前预计下调油价110元/吨(0.08元/升-0.10元/升)</span>'))).trend;
    assert.strictEqual(t.direction, 'down');
    assert.strictEqual(t.date, '2026-11-24');
    assert.strictEqual(t.changeTon, -110);
    assert.strictEqual(t.literMin, 0.08);
    assert.strictEqual(t.literMax, 0.10);
  });

  check(label + ' 搁浅：方向 flat，幅度归零', () => {
    const t = parse(page(trendDiv('下次油价11月24日24时调整，目前预计搁浅（不作调整）'))).trend;
    assert.strictEqual(t.direction, 'flat');
    assert.strictEqual(t.changeTon, 0);
    assert.strictEqual(t.literMin, 0);
    assert.strictEqual(t.literMax, 0);
  });

  check(label + ' 只有方向没有幅度：幅度为 null，不猜', () => {
    const t = parse(page(trendDiv('下次油价11月24日24时调整，目前预计上调'))).trend;
    assert.strictEqual(t.direction, 'up');
    assert.strictEqual(t.changeTon, null);
    assert.strictEqual(t.literMin, null);
    assert.strictEqual(t.literMax, null);
  });

  check(label + ' 只有日期没有方向 → trend null', () => {
    assert.strictEqual(parse(page(trendDiv('下次油价11月24日24时调整'))).trend, null);
  });

  check(label + ' 全角括号与波浪号区间', () => {
    const t = parse(page(trendDiv('下次油价11月24日24时调整，预计上调110元/吨（0.08元/升～0.10元/升）'))).trend;
    assert.strictEqual(t.changeTon, 110);
    assert.strictEqual(t.literMin, 0.08);
    assert.strictEqual(t.literMax, 0.10);
  });

  check(label + ' 被注释的旧预测 div 不参与解析', () => {
    const html = page('<!--<div style="border:solid 1px #EA5146;">汽油价格网各地区油价已于2017年5月26日0时更新</div>-->');
    const r = parse(html);
    assert(r.prices, '价格应正常解析');
    assert.strictEqual(r.trend, null);
  });

  check(label + ' 跨年：12 月底看到 1 月窗口 → 下一年', () => {
    const dec30 = Date.UTC(2026, 11, 30, 4);
    const t = parse(page(trendDiv('下次油价1月5日24时调整，预计上调油价100元/吨(0.08元/升-0.09元/升)')), dec30).trend;
    assert.strictEqual(t.date, '2027-01-05');
  });

  // ⚠️ 下面这组用例用的是**发改委公告的真实原文**（2026-11-16 抓取，
  // 原文出处见下方注释）。发改委公告只给吨价、只分汽/柴油两类，
  // **不给四油品每升幅度** —— 每升幅度由展示层拿挂牌价前后快照差值测算。
  //
  // 原文出处（国家发展和改革委员会 · 新闻发布）：
  //   https://www.ndrc.gov.cn/xwdt/xwfb/202611/t20261112_1408795.html
  //   https://www.ndrc.gov.cn/xwdt/xwfb/202610/t20261029_1408449.html
  //   https://www.ndrc.gov.cn/xwdt/xwfb/202610/t20261015_1408170.html
  //   https://www.ndrc.gov.cn/xwdt/xwfb/202609/t20260924_1407824.html
  const ndrcParse = (file) => sources.PARSERS.ndrcNotice(
    fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', file), 'utf8')
  );
  // 拼一个最小页面：解析器只认 meta / h2 / article_con / TRS_Editor 这几处
  const ndrcPage = (body, title, pubDate) => '<html><head>' +
    '<meta name="ArticleTitle" content="' + (title || '') + '">' +
    '<meta name="PubDate" content="' + (pubDate || '') + '">' +
    '</head><body><div class="article"><div class="article_l">' +
    '<h2 class="article_title">' + (title || '') + '</h2>' +
    '<div class="article_con article_con_title"><div class=TRS_Editor><div>' + body + '</div></div></div>' +
    '</div><div class="article_r"></div></div></body></html>';

  check(label + ' ndrcNotice 列表页：相对链接拼成绝对地址', () => {
    const html = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'ndrc-list.html'), 'utf8');
    const list = sources.PARSERS.ndrcNoticeList(html, 'https://www.ndrc.gov.cn/xwdt/xwfb/');
    assert(list.items.length > 0, '列表页应解析出公告链接');
    const oil = list.items.filter((i) => /成品油价格/.test(i.title));
    assert.strictEqual(oil.length, 4);
    // ⚠️ 列表页 href 是 ./202611/… 这种相对链接。手工拼字符串会变成
    // www.ndrc.gov.cn. 这种带尾点的域名，证书 altnames 直接不匹配。
    assert.strictEqual(oil[0].url, 'https://www.ndrc.gov.cn/xwdt/xwfb/202611/t20261112_1408795.html');
    assert.strictEqual(oil[0].publishedAt, '2026-11-12');
  });

  check(label + ' ndrcNotice 真实公告：下调 645/625 元每吨', () => {
    const r = ndrcParse('ndrc-2026-11-12.html');
    assert.strictEqual(r.direction, 'down');
    assert.deepStrictEqual(r.tonChanges, { gasoline: -645, diesel: -625 });
    assert.strictEqual(r.executeAt, '2026-11-12');
    assert.strictEqual(r.announcedAt, '2026-11-12');
    assert.strictEqual(r.reviewStatus, 'approved');
    // 公告不给每升四油品幅度 —— 留空，由展示层测算，不在这里猜
    assert.deepStrictEqual(r.deltas, {});
  });

  check(label + ' ndrcNotice 调控类：取「实际上调」不取「应上调」', () => {
    const r = ndrcParse('ndrc-2026-10-29.html');
    // 原文同段里既有「应上调440元、420元」也有「调控后实际上调345元、335元」，
    // 只有后者是实际执行值 —— 拿理论值当执行值就是替来源编数字。
    assert.strictEqual(r.direction, 'up');
    assert.deepStrictEqual(r.tonChanges, { gasoline: 345, diesel: 335 });
    assert.strictEqual(r.executeAt, '2026-10-29');
    assert.strictEqual(r.reviewStatus, 'approved');
  });

  check(label + ' ndrcNotice 调控类第二篇：395/385 而不是理论值 830/800', () => {
    const r = ndrcParse('ndrc-2026-09-24.html');
    assert.deepStrictEqual(r.tonChanges, { gasoline: 395, diesel: 385 });
  });

  check(label + ' ndrcNotice 搁浅：方向 flat，不编幅度', () => {
    const r = ndrcParse('ndrc-2026-10-15.html');
    assert.strictEqual(r.direction, 'flat');
    assert.deepStrictEqual(r.tonChanges, {});
    assert.strictEqual(r.executeAt, '2026-10-15');
    assert.strictEqual(r.reviewStatus, 'approved');
  });

  check(label + ' ndrcNotice 只有「应上调」：理论值不算实际执行值', () => {
    const r = sources.PARSERS.ndrcNotice(ndrcPage(
      '根据现行价格机制计算，自10月29日24时起，国内汽、柴油（标准品）价格每吨分别应上调440元、420元。',
      '2026年10月29日国内成品油价格调整',
      '2026-10-29'
    ));
    assert.strictEqual(r.direction, 'up', '方向是明确的');
    assert.deepStrictEqual(r.tonChanges, {}, '「应上调」是机制理论值，不能当实际执行幅度');
    assert.strictEqual(r.theoryOnly, true);
    assert.strictEqual(r.reviewStatus, 'pending', '没有实际幅度就存疑，不对外发布');
  });

  check(label + ' ndrcNotice 不拿上一轮的日期当本轮生效日', () => {
    const r = sources.PARSERS.ndrcNotice(ndrcPage(
      '上次调价自2026年11月1日24时起，本轮国内汽、柴油（标准品）价格每吨分别下调645元、625元。',
      '2026年11月12日国内成品油价格调整',
      '2026-11-12'
    ));
    // 正文里唯一带「24时起」的是上一轮的日期 → 不能当本轮生效日
    assert.notStrictEqual(r.executeAt, '2026-11-01');
    assert.strictEqual(r.executeAt, '2026-11-12', '执行日退回标题里的日期');
  });

  check(label + ' ndrcNotice 跨年：12 月发布、次年 1 月执行', () => {
    const r = sources.PARSERS.ndrcNotice(ndrcPage(
      '根据国际市场油价变化情况，自1月5日24时起，国内汽、柴油（标准品）价格每吨分别下调100元、95元。',
      '2025年12月31日国内成品油价格调整',
      '2025-12-31'
    ));
    assert.strictEqual(r.executeAt, '2026-01-05');
  });

  check(label + ' ndrcNotice 方向解析不出来：判存疑', () => {
    const r = sources.PARSERS.ndrcNotice(ndrcPage(
      '根据国际市场油价变化情况，国内汽、柴油价格适当调整。',
      '2026年11月12日国内成品油价格适当调整',
      '2026-11-12'
    ));
    assert.strictEqual(r.direction, '', '「适当调整」看不出方向，不猜');
    assert.strictEqual(r.reviewStatus, 'pending');
  });
}

/* ---------- 主流程 ---------- */

console.log('--- 采集源配置 ---');
check('31 个地区都有 slug 且唯一（陕西 shanxi-3 / 山西 shanxi）', () => {
  assert.strictEqual(REGIONS.length, 31);
  const slugs = REGIONS.map(r => r.slug);
  assert(slugs.every(s => typeof s === 'string' && s.length > 0), '有地区缺 slug');
  assert.strictEqual(new Set(slugs).size, 31, 'slug 有重复');
  assert.strictEqual(REGIONS.find(r => r.name === '陕西').slug, 'shanxi-3');
  assert.strictEqual(REGIONS.find(r => r.name === '山西').slug, 'shanxi');
});


for (const [label, sources] of IMPLS) {
  console.log('--- ' + label + ' 解析器 ---');
  runSuite(label, sources);
}



/* ---------- 真实抓取（可选） ---------- */

async function live() {
  console.log('--- 真实抓取验证 ---');
  const httpClient = require(path.join(ROOT, 'server', 'src', 'services', 'http-client'));
  const source = IMPLS[0][1].SOURCES.find(x => x.id === 'qiyoujiage');
  for (const slug of ['beijing', 'shanxi-3', 'yunnan']) {
    const region = REGIONS.find(r => r.slug === slug);
    // 站点对密集请求会回 567（限流），live 模式间隔一下；
    // 生产采集走 3 并发、且有 6 小时新鲜期，不会这么打
    await new Promise(r => setTimeout(r, 1500));
    try {
      const res = await httpClient.get(source.url + slug + '.shtml', { headers: source.headers, timeout: 15000 });
      assert.strictEqual(res.statusCode, 200);
      const r = IMPLS[0][1].PARSERS.qiyoujiageRegion(res.body);
      assert(r, '解析为 null');
      for (const f of ['92', '95', '98', '0']) {
        assert(r.prices[f] >= 3 && r.prices[f] <= 20, f + ' 价格超区间');
      }
      console.log('✓ ' + region.name + ' 92#=' + r.prices['92'] + ' 95#=' + r.prices['95'] +
        ' 98#=' + r.prices['98'] + ' 0#=' + r.prices['0'] +
        (r.trend ? ' | 下次窗口 ' + r.trend.date + ' ' + r.trend.direction : ' | 无预测'));
    } catch (e) {
      failures++;
      console.error('✗ ' + region.name + ' 真实抓取失败：' + e.message);
    }
  }
  await liveDb(source);
}

/**
 * 入库链路集成验证：pg-mem 内存库 + 真实抓取，
 * 覆盖 单地区采集 → 新鲜期跳过 → force 重抓去重 → 全量 run()。
 * 只断言结构与去重行为，不断言具体价格（调价后挂牌价会变）。
 */
async function liveDb(source) {
  console.log('--- 入库链路（pg-mem + 真实抓取） ---');
  process.env.OIL_ALLOW_NO_DATABASE = '1';
  const { newDb } = require(path.join(ROOT, 'server', 'node_modules', 'pg-mem'));
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  const dbModule = require(path.join(ROOT, 'server', 'src', 'db.js'));
  const pgPool = new adapter.Pool();
  dbModule.pool.query = (text, params) => pgPool.query(text, params);
  await mem.public.query(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));

  const dao = require(path.join(ROOT, 'server', 'src', 'dao'));
  const collector = require(path.join(ROOT, 'server', 'src', 'services', 'collector'));
  const cnToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

  try {
    const r1 = await collector.collectFromSource(source, { regionCode: '110000' });
    assert.strictEqual(r1.status, 'ok', '单地区采集状态：' + JSON.stringify(r1));
    assert.strictEqual(r1.saved, 1);
    const prices = await dao.prices.listByRegion('110000');
    assert.strictEqual(prices.length, 4, '北京应有 4 条价格');
    assert(prices.every(p => p.source === 'qiyoujiage'), '价格来源标记');
    assert(prices.every(p => p.price >= 3 && p.price <= 20), '价格区间');
    assert(prices.every(p => p.changeAmount === 0), '首次采集 changeAmount 应为 0');
    const hist = await dao.history.listByRegionFuel('110000', '92');
    assert.strictEqual(hist.length, 1, '首次采集应写 1 条今日历史价');
    assert.strictEqual(hist[0].date, cnToday);
    const win = await dao.windows.latestBySource('qiyoujiage');
    assert(win, '预测窗口未写入');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(win.date), '窗口日期格式');
    assert.strictEqual(win.isOfficial, false, '预测必须非官方');
    assert.strictEqual(typeof win.forecast['92'], 'number', 'forecast 按油品存数值');
    assert(win.basis.includes('非官方'), 'basis 要标注非官方');
    console.log('✓ 单地区采集：价格/历史/窗口入库（窗口 ' + win.date + '，92# 预测 ' + win.forecast['92'] + '）');

    const r2 = await collector.collectFromSource(source, { regionCode: '110000' });
    assert.strictEqual(r2.status, 'ok');
    assert.strictEqual(r2.saved, 0, '新鲜期内应跳过');
    assert.strictEqual(r2.fresh, 1);
    console.log('✓ 新鲜期跳过：6 小时内不重复抓取');

    const r3 = await collector.collectFromSource(source, { regionCode: '110000', force: true });
    assert.strictEqual(r3.saved, 1);
    assert.strictEqual((await dao.prices.listByRegion('110000')).length, 4, 'force 重抓不应产生重复价格');
    assert.strictEqual((await dao.history.listByRegionFuel('110000', '92')).length, 1, '同日历史价应 upsert 不重复');
    assert.strictEqual(r3.window.deduped, true, '预测未变应去重');
    console.log('✓ force 重抓：价格/历史/窗口全部去重');

    const run1 = await collector.run();
    assert.strictEqual(run1.status, 'ok', '全量 run 状态：' + JSON.stringify(run1.results));
    const all = await dao.prices.listAll();
    assert.strictEqual(all.length, 31 * 4, '全量应写 124 条价格，实际 ' + all.length);
    const run2 = await collector.run();
    const priceResult = run2.results.find(r => r.sourceId === 'qiyoujiage');
    assert.strictEqual(priceResult.saved, 0, '第二次 run 应全部新鲜跳过');
    assert.strictEqual(run2.status, 'ok', '新鲜跳过时 run 状态应为 ok（不是 idle）');
    console.log('✓ 全量 run：31 省 124 条价格；第二次 run 全部新鲜跳过');
  } catch (e) {
    failures++;
    console.error('✗ 入库链路失败：' + e.message);
  }
}

Promise.resolve()
  .then(() => (process.argv.includes('--live') ? live() : null))
  .then(() => {
    if (failures) {
      console.error('\n' + failures + ' 个用例失败');
      process.exit(1);
    }
    console.log('\n采集器验证全部通过');
  });