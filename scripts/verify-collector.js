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

  check(label + ' ndrcNotice 回归：方向正负号', () => {
    const up = sources.PARSERS.ndrcNotice('国内成品油价格按机制上调。自2026年11月12日24:00起，每升上调0.08元。');
    assert.strictEqual(up.delta, 0.08);
    assert.strictEqual(up.executeAt, '2026-11-12');
    const down = sources.PARSERS.ndrcNotice('每升下调0.08元');
    assert.strictEqual(down.delta, -0.08);
  });

  // ⚠️ 下面这组用例钉的是「机器判定可信」的前提：
  // 标号要从正文里明确抓到数字，泛称不猜；日期要认「24时」。
  // 解析错标号的后果是 98# 的幅度被记到 92# 头上，
  // 而 perFuel 还判定成「解析成功」—— 错的幅度会被当成可信结果发布出去。
  check(label + ' ndrcNotice 逐项写法：四个油品各归各的', () => {
    const r = sources.PARSERS.ndrcNotice(
      '国家发展改革委宣布国内成品油价格按机制下调。从2026年11月24日24时起，全国平均来看：' +
      '92号汽油每升下调0.08元，95号汽油每升下调0.08元，98号汽油每升下调0.10元，0号柴油每升下调0.08元。'
    );
    assert.deepStrictEqual(r.deltas, { '92': -0.08, '95': -0.08, '98': -0.1, '0': -0.08 });
    assert.strictEqual(r.perFuel, true);
    assert.strictEqual(r.executeAt, '2026-11-24');
    assert.strictEqual(r.reviewStatus, 'approved');
  });

  check(label + ' ndrcNotice 顿号串号：列表里的每个标号都拿到那个幅度', () => {
    const r = sources.PARSERS.ndrcNotice(
      '自2026年11月24日24时起，92号汽油、98号汽油每升下调0.10元。'
    );
    // 「A、B每升X元」是公告的列表写法：A 与 B 都适用这个幅度。
    // ⚠️ 旧解析器把这种写法读成「只有最后一个标号算数」，
    // 92# 明明写在正文里却被丢掉 —— 而且照样判成 approved。
    assert.strictEqual(r.deltas['98'], -0.1);
    assert.strictEqual(r.deltas['92'], -0.1, '92# 在正文里写了，同一个幅度也适用它');
  });

  check(label + ' ndrcNotice 四油品共用一个幅度：逐项齐全判可信', () => {
    const r = sources.PARSERS.ndrcNotice(
      '自2026年11月24日24时起，92号汽油、95号汽油、98号汽油每升下调0.10元，0号柴油每升下调0.10元。'
    );
    assert.deepStrictEqual(r.deltas, { '92': -0.1, '95': -0.1, '98': -0.1, '0': -0.1 });
    assert.strictEqual(r.perFuel, true);
    assert.strictEqual(r.reviewStatus, 'approved');
  });

  check(label + ' ndrcNotice 只有总幅度：不复制给四个油品，判存疑', () => {
    const r = sources.PARSERS.ndrcNotice('自2026年11月24日24时起，每升下调0.08元。');
    assert.deepStrictEqual(r.deltas, {}, '总幅度不能复制给四个油品');
    assert.strictEqual(r.perFuel, false);
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 泛称「汽油」：猜不出标号，不填', () => {
    const r = sources.PARSERS.ndrcNotice('自2026年11月24日24时起，汽油每升下调0.08元。');
    assert.deepStrictEqual(r.deltas, {}, '汽油有 92/95/98 三个标号，猜不出来');
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 有幅度没日期：正文格式不符，判存疑', () => {
    const r = sources.PARSERS.ndrcNotice('92号汽油每升下调0.08元，98号汽油每升下调0.10元。');
    // ⚠️ perFuel 的含义是「四油品逐项齐全」：只解析出 2 个油品时
    // 缺失的两个是**猜不出来的**，不能当成「逐项解析成功」。
    assert.strictEqual(r.perFuel, false, '只解析出 2 个油品不算逐项齐全');
    assert.strictEqual(r.executeAt, null);
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 中性词「调整」不猜方向，判存疑', () => {
    const r = sources.PARSERS.ndrcNotice(
      '自2026年11月24日24时起，92号汽油每升调整0.10元，95号汽油每升调整0.10元，' +
      '98号汽油每升调整0.10元，0号柴油每升调整0.10元。'
    );
    // 「调整」看不出上调还是下调 —— 之前非「下调」一律取正，
    // 等于把一条方向不明的公告当成**上涨**发布出去。
    assert.strictEqual(r.ambiguousDirection, true);
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 不拿上一轮的日期当本轮生效日', () => {
    const r = sources.PARSERS.ndrcNotice(
      '上次调价自2026年11月1日24时起，本轮92号汽油每升下调0.10元，95号汽油每升下调0.10元，' +
      '98号汽油每升下调0.10元，0号柴油每升下调0.10元。'
    );
    assert.strictEqual(r.executeAt, null, '上一轮的日期不是本轮生效日');
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 同一油品两种幅度，判存疑', () => {
    const r = sources.PARSERS.ndrcNotice(
      '自2026年11月24日24时起，92号汽油每升下调0.10元，92号汽油每升下调0.20元，95号汽油每升下调0.10元，' +
      '98号汽油每升下调0.10元，0号柴油每升下调0.10元。'
    );
    assert.strictEqual(r.conflict, true);
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 各油品方向不一致，判存疑', () => {
    const r = sources.PARSERS.ndrcNotice(
      '自2026年11月24日24时起，92号汽油每升下调0.10元，95号汽油每升上调0.10元，' +
      '98号汽油每升下调0.10元，0号柴油每升下调0.10元。'
    );
    assert.strictEqual(r.mixedDirection, true);
    assert.strictEqual(r.reviewStatus, 'pending');
  });

  check(label + ' ndrcNotice 日期认「24时」', () => {
    const r = sources.PARSERS.ndrcNotice('自2026年11月24日24时起，每升下调0.08元。');
    assert.strictEqual(r.executeAt, '2026-11-24');
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