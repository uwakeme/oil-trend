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

  check(label + ' 来源配置：qiyoujiage 改为预测源（保留兜底 + 交叉校核）', () => {
    const s = sources.SOURCES.find(x => x.id === 'qiyoujiage');
    assert(s, '缺少 qiyoujiage 来源');
    assert.strictEqual(s.enabled, true);
    // 2026-11-16 起主源换成 xmgcn（现价+历史），它只留三件事：
    // 下次调价预测（全网唯一）、主源失败时兜底现价、交叉校核。
    assert.strictEqual(s.kind, 'forecast');
    assert.strictEqual(s.priority, 2, '降级链里排第二');
    assert(s.provides.includes('forecast'), '要提供预测');
    assert(s.provides.includes('price'), '仍要能兜底现价');
    assert.strictEqual(s.verifyRegions.length, 3, '交叉校核抽 3 个省');
    assert.strictEqual(typeof sources.PARSERS[s.parser], 'function');
    assert(s.urlTemplate.indexOf('{slug}') > 0, 'urlTemplate 要带 {slug} 占位');
  });

  check(label + ' 来源配置：xmgcn 是现价+历史主源，且有 HTTPS', () => {
    const s = sources.SOURCES.find(x => x.id === 'xmgcn');
    assert(s, '缺少 xmgcn 来源');
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.kind, 'price');
    assert.strictEqual(s.priority, 1, '主源优先');
    assert(s.provides.includes('price') && s.provides.includes('history'));
    assert(s.urlTemplate.startsWith('https://'), 'xmgcn 有 HTTPS');
    assert.strictEqual(typeof sources.PARSERS[s.parser], 'function');
  });

  check(label + ' 来源配置：官方调价时间表源只做口径互校', () => {
    const s = sources.SOURCES.find(x => x.id === 'xmgcn-timeline');
    assert(s, '缺少 xmgcn-timeline 来源');
    assert.strictEqual(s.kind, 'timeline');
    assert.deepStrictEqual(s.provides, ['timeline']);
    assert.strictEqual(typeof sources.PARSERS[s.parser], 'function');
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

  /* ---------- 油价网（xmgcn）：现价 + 历史 ---------- */

  const xmgcnFixture = () =>
    fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'xmgcn-guangdong.html'), 'utf8');
  const parseXmgcn = (html) => sources.PARSERS.xmgcnRegion(html);
  /** 把历史表 tbody 裁到只剩前 keep 行，用来造残页 */
  function truncateHistoryRows(html, keep) {
    return html.replace(/(<tbody>)[\s\S]*?(<\/tbody>)/, function (m, a, b) {
      const rows = m.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      return a + rows.slice(0, keep).join('') + b;
    });
  }

  check(label + ' xmgcnRegion 真实快照：现价 + 30 期历史，日期升序', () => {
    const r = parseXmgcn(xmgcnFixture());
    assert(r, '解析为 null');
    assert.deepStrictEqual(r.prices, { '92': 8.39, '95': 9.09, '98': 11.09, '0': 8.06 });
    assert.strictEqual(r.history.length, 30);
    // ⚠️ 页面行序是**降序**（最新在前），解析器必须按日期升序重排。
    // 顺序搞反的话「相邻期变化」会全部反号，测出来的涨跌额也跟着反。
    for (let i = 1; i < r.history.length; i++) {
      assert(r.history[i].date > r.history[i - 1].date, '历史必须升序：' + r.history[i].date);
    }
    assert.strictEqual(r.history[0].date, '2025-09-10');
    assert.strictEqual(r.history[r.history.length - 1].date, '2026-11-13');
  });

  check(label + ' xmgcnRegion 历史末行价格 == 同页现价（首尾自洽闸门的前提）', () => {
    const r = parseXmgcn(xmgcnFixture());
    const last = r.history[r.history.length - 1];
    for (const f of ['92', '95', '98', '0']) {
      assert.strictEqual(last.prices[f], r.prices[f], f + '# 历史末行与现价不符');
    }
  });

  check(label + ' xmgcnRegion 站点涨跌列与相邻期价差一致（零偏差）', () => {
    const r = parseXmgcn(xmgcnFixture());
    let n = 0;
    for (let i = 1; i < r.history.length; i++) {
      for (const f of ['92', '95', '98', '0']) {
        const prev = r.history[i - 1].prices[f];
        const cur = r.history[i].prices[f];
        const ch = r.history[i].changes[f];
        if (typeof prev !== 'number' || typeof cur !== 'number' || typeof ch !== 'number') continue;
        n++;
        assert(Math.abs(ch - (cur - prev)) <= 0.005,
          r.history[i].date + ' ' + f + '# 涨跌列 ' + ch + ' ≠ 实际 ' + (cur - prev).toFixed(2));
      }
    }
    assert(n >= 100, '样本太少：' + n);
  });

  check(label + ' xmgcnRegion 残页（tbody 空 / 行数不足）→ null，让采集器重试', () => {
    // 密集请求时站点会返回半张表 —— 半张表比没有表更危险，必须判失败重试
    assert.strictEqual(parseXmgcn(truncateHistoryRows(xmgcnFixture(), 10)), null);
    assert.strictEqual(parseXmgcn(
      xmgcnFixture().replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody></tbody>')
    ), null);
  });

  check(label + ' xmgcnRegion 缺油品 / 超区间 / 空页面 → null（转人工）', () => {
    assert.strictEqual(parseXmgcn(''), null);
    // 98# 卡片改个 class → 凑不齐四油品
    assert.strictEqual(parseXmgcn(xmgcnFixture().replace('price-card n98', 'price-card x98')), null);
    // 价格超区间 → 结构变了或解析错位
    assert.strictEqual(parseXmgcn(xmgcnFixture().replace('>8.39<', '>99<')), null);
  });

  check(label + ' xmgcnRegion 整数价格不与涨跌粘连（价格 10 + 涨跌 0 ≠ 100）', () => {
    // ⚠️ 这是真踩过的坑：去掉空白后「10」+「0」粘成「100」。
    // 内蒙古 98# 在 2026-09-25 / 2026-10-16 正好是整数 10，
    // 粘成 100 之后那两期的涨跌变成 +90 / -89.68，整条序列全乱，
    // 跨省一致性闸门还会误报「偏离 89.98」。
    const html = xmgcnFixture().replace(
      /<td class="price-cell">\s*<div>\s*7\.13\s*<\/div>\s*<div class="change-cell change-unchanged">\s*0\s*<\/div>\s*<\/td>/,
      '<td class="price-cell"> <div> 10 </div> <div class="change-cell change-unchanged"> 0 </div> </td>'
    );
    const r = parseXmgcn(html);
    assert(r, '解析为 null');
    const row = r.history.filter(function (h) { return h.date === '2025-09-24'; })[0];
    assert(row, '找不到 2025-09-24 那期');
    assert.strictEqual(row.prices['92'], 10, '整数价格应解析成 10，不是 100');
    assert.strictEqual(row.changes['92'], 0, '持平的涨跌是 0');
    assert(r.history.every(function (h) { return h.prices['92'] !== 100; }), '不应出现 100');
  });

  check(label + ' qiyoujiage 新文案：轮次后的「结果」写法能解析，但标记为非预测', () => {
    // 2026-11-16 实测：轮次一过，站点把区块从
    //   「下次油价X月X日24时调整 … 目前预计上调油价90元/吨(0.07元/升-0.08元/升)」
    // 改成
    //   「油价X月X日24时调整 … 下跌0.51元/升-0.63元/升」
    // 「下次」「预计」这两个词只在预测写法里出现，是区分二者的唯一依据。
    const t = parse(page(trendDiv('油价11月12日24时调整<br/><span>下跌0.51元/升-0.63元/升,大家相互转告油价大跌了 。</span>'))).trend;
    assert(t, 'trend 为 null');
    assert.strictEqual(t.direction, 'down');
    assert.strictEqual(t.date, '2026-11-12');
    assert.strictEqual(t.literMin, 0.51);
    assert.strictEqual(t.literMax, 0.63);
    assert.strictEqual(t.isForecast, false, '没有「预计」二字 → 是已发生轮次的结果');
    assert.strictEqual(t.changeTon, null, '结果写法没给吨价，不猜');
  });

  check(label + ' qiyoujiage 预测写法仍标记为 isForecast', () => {
    const t = parse(page(trendDiv('下次油价11月24日24时调整<br/><span>目前预计上调油价90元/吨(0.07元/升-0.08元/升)，大家相互提醒油价又涨了 。</span>'))).trend;
    assert(t, 'trend 为 null');
    assert.strictEqual(t.isForecast, true);
    assert.strictEqual(t.direction, 'up');
    assert.strictEqual(t.changeTon, 90);
  });

  check(label + ' xmgcnTimeline 真实快照：全国调价时间表（吨价口径）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'xmgcn-tiaozheng.html'), 'utf8');
    const t = sources.PARSERS.xmgcnTimeline(html);
    assert(t, '解析为 null');
    assert.strictEqual(t.items.length, 50);
    assert.strictEqual(t.items[0].date, '2024-05-16');
    const last = t.items[t.items.length - 1];
    assert.strictEqual(last.date, '2026-11-13');
    // 最后一轮就是发改委 2026-11-12 公告的那一轮：汽油下调 645、柴油下调 625
    assert.strictEqual(last.gasolineDelta, -645);
    assert.strictEqual(last.dieselDelta, -625);
    // 升序
    for (let i = 1; i < t.items.length; i++) {
      assert(t.items[i].date > t.items[i - 1].date, '时间表必须升序');
    }
  });

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

/* ---------- 国际行情（kind = market） ---------- */

/**
 * 行情源与解析器的离线回归。
 *
 * 夹具是 2026-11-28 的真实响应：
 *   scripts/fixtures/eastmoney-wti-quote.json    东财快照（JSON）
 *   scripts/fixtures/eastmoney-wti-kline-5m.json  东财 5 分钟 K 线
 *   scripts/fixtures/eastmoney-wti-kline-day.json 东财日 K 线
 *   scripts/fixtures/sina-hf-oil.json             新浪快照（原始字节，GB18030）
 */
function runMarketSuite(label, sources) {
  const httpClient = require(path.join(ROOT, 'server', 'src', 'services', 'http-client'));
  const collector = require(path.join(ROOT, 'server', 'src', 'services', 'collector'));
  const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', name), 'utf8'));

  check(label + ' 行情源配置：两个品种都有源、启用、走 HTTPS、解析器齐全', () => {
    const wti = sources.SOURCES.find(x => x.id === 'market-wti');
    const brent = sources.SOURCES.find(x => x.id === 'market-brent');
    assert(wti, '缺少 market-wti 来源');
    assert(brent, '缺少 market-brent 来源');
    [wti, brent].forEach(s => {
      assert.strictEqual(s.enabled, true, s.id + ' 没启用');
      assert.strictEqual(s.kind, 'market');
      assert(s.provides.includes('market'), s.id + ' 要提供行情');
      assert(s.quoteUrl.startsWith('https://'), s.id + ' 快照要走 HTTPS');
      assert(s.allowedHosts && s.allowedHosts.length, s.id + ' 要有跳转白名单');
      assert.strictEqual(typeof sources.PARSERS[s.parser], 'function', s.id + ' 解析器缺失');
      // 口径与授权说明必须写清楚：这是用户能看到的数字
      assert(s.note && s.note.length > 10, s.id + ' 要写清口径与授权说明');
    });
    assert(wti.seriesUrls && wti.seriesUrls.length >= 1, 'WTI 要有历史曲线接口');
    assert.strictEqual(typeof sources.PARSERS[wti.seriesParser], 'function', 'K 线解析器缺失');
    // ⚠️ 新浪的接口要带来源页 Referer，否则回空
    assert(/Referer/i.test(JSON.stringify(brent.headers)), '新浪行情接口要带 Referer');
  });

  check(label + ' 东财快照解析：价格/涨跌/开高低/昨收/报价时刻', () => {
    const q = sources.PARSERS.eastmoneyQuote(JSON.stringify(fx('eastmoney-wti-quote.json').body));
    assert(q, '解析为 null');
    assert.strictEqual(q.price, 83.33);
    assert.strictEqual(q.prevClose, 83.68);
    assert.strictEqual(q.open, 84.81);
    assert.strictEqual(q.high, 86.6);
    assert.strictEqual(q.low, 82.57);
    assert.strictEqual(q.changeAmount, -0.35);
    assert.strictEqual(q.changePercent, -0.42);
    assert.strictEqual(q.name, 'NYMEX原油');
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.quoteTime), q.quoteTime);
    // Unix 秒 1795809361 = UTC+8 的 2026-11-28 03:56:01
    assert.strictEqual(q.quoteTime, '2026-11-28 03:56:01');
  });

  check(label + ' 东财快照漏了 fltt=2（字段放大 100 倍）→ 不采信', () => {
    // f43 会是 8333 而不是 83.33：不挡住的话页面上就是 8333 美元/桶
    const bad = JSON.stringify({ data: { f43: 8333, f58: 'NYMEX原油' } });
    assert.strictEqual(sources.PARSERS.eastmoneyQuote(bad), null);
  });

  check(label + ' 东财 K 线解析：分钟线补秒、日线保持纯日期', () => {
    const m = sources.PARSERS.eastmoneyKline(JSON.stringify(fx('eastmoney-wti-kline-5m.json').body));
    assert(m && m.points.length, '分钟线解析为空');
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.points[0].date), m.points[0].date);
    const d = sources.PARSERS.eastmoneyKline(JSON.stringify(fx('eastmoney-wti-kline-day.json').body));
    assert(d && d.points.length, '日线解析为空');
    // 日线保持纯日期：补成 00:00 的话图上会显示「11-27 00:00」
    assert(/^\d{4}-\d{2}-\d{2}$/.test(d.points[0].date), d.points[0].date);
    // 取的是**收盘价**（第 3 段），不是开盘价
    const row = fx('eastmoney-wti-kline-day.json').body.data.klines[0].split(',');
    assert.strictEqual(d.points[0].value, Number(row[2]), '应取收盘价');
  });

  check(label + ' 新浪快照：GB18030 解码后字段齐全', () => {
    const f = fx('sina-hf-oil.json');
    const body = httpClient.decodeBody(Buffer.from(f.base64, 'base64'), f.contentType, '');
    const q = sources.PARSERS.sinaQuote(body);
    assert(q, '解析为 null');
    assert.strictEqual(q.price, 90.697);
    assert.strictEqual(q.prevClose, 91.67);
    assert.strictEqual(q.open, 91.84);
    assert.strictEqual(q.high, 93.17);
    assert.strictEqual(q.low, 89.86);
    assert.strictEqual(q.name, '布伦特原油');
    assert.strictEqual(q.quoteTime, '2026-11-28 03:59:58');
    // 接口自己不给涨跌：用「现价 - 昨收」算，并收口到两位小数
    // （不收口会出现 -0.972999999999999 这种尾巴，传到界面上很难看）
    assert.strictEqual(q.changeAmount, -0.97, String(q.changeAmount));
    assert.strictEqual(q.changePercent, -1.06, String(q.changePercent));
  });

  check(label + ' 新浪快照：GB18030 字节流解码（按 UTF-8 解会变乱码）', () => {
    const f = fx('sina-hf-oil.json');
    const buf = Buffer.from(f.base64, 'base64');
    assert(buf.toString('utf8').indexOf('布伦特原油') < 0, '按 UTF-8 解不该读得出中文（否则测不到编码差异）');
    assert(httpClient.decodeBody(buf, f.contentType, '').indexOf('布伦特原油') >= 0, '按 GB18030 解要读得出中文');
  });

  check(label + ' 行情解析：坏结构 → null（转人工，不猜）', () => {
    assert.strictEqual(sources.PARSERS.eastmoneyQuote('not json'), null);
    assert.strictEqual(sources.PARSERS.eastmoneyQuote(JSON.stringify({ data: null })), null);
    assert.strictEqual(sources.PARSERS.eastmoneyKline(JSON.stringify({ data: { klines: [] } })), null);
    assert.strictEqual(sources.PARSERS.sinaQuote(''), null);
    assert.strictEqual(sources.PARSERS.sinaQuote('var hq_str_hf_OIL="1,2,3";'), null);
  });

  check(label + ' 曲线合并：同一天有分钟线时不再留日线那根，且按时间升序', () => {
    const merged = collector.mergeMarketPoints([
      { date: '2026-11-27', value: 83.33 },
      { date: '2026-11-27 23:50:00', value: 83.33 },
      { date: '2026-11-26', value: 84.91 },
      { date: '2026-11-26', value: 99.99 }
    ]);
    // 11-27 有分钟线 → 那根日线不要了（画出来是一根多余的台阶）
    assert.strictEqual(merged.filter(p => p.date === '2026-11-27').length, 0, '日线那根应被去掉');
    assert(merged.some(p => p.date === '2026-11-27 23:50:00'), '分钟线要留着');
    // 11-26 没有分钟线 → 日线留着；同一时间戳只留最后一个
    assert.strictEqual(merged.filter(p => p.date === '2026-11-26').length, 1);
    assert.strictEqual(merged.find(p => p.date === '2026-11-26').value, 99.99);
    // 升序
    for (let i = 1; i < merged.length; i++) {
      assert(merged[i].date > merged[i - 1].date, '曲线必须按时间升序');
    }
  });
}

/* ---------- 主流程 ---------- */

console.log('--- 采集源配置 ---');
check('31 个地区每个来源各有一套 slug 且唯一（拼音撞名省份两套不同）', () => {
  assert.strictEqual(REGIONS.length, 31);
  for (const sourceId of ['qiyoujiage', 'xmgcn']) {
    const slugs = REGIONS.map(r => r.slugs[sourceId]);
    assert(slugs.every(s => typeof s === 'string' && s.length > 0), sourceId + ' 有地区缺 slug');
    assert.strictEqual(new Set(slugs).size, 31, sourceId + ' 的 slug 有重复');
  }
  // ⚠️ 两个站点的 slug 不一样，按拼音猜必错：
  //   陕西 qiyoujiage=shanxi-3 / xmgcn=shanxi2
  //   内蒙古 qiyoujiage=neimenggu / xmgcn=namenggu
  //   西藏 qiyoujiage=xizang / xmgcn=xicang
  //   山西 两边都是 shanxi（山西跟陕西不撞，撞的是「陕」）
  assert.strictEqual(REGIONS.find(r => r.name === '陕西').slugs.qiyoujiage, 'shanxi-3');
  assert.strictEqual(REGIONS.find(r => r.name === '陕西').slugs.xmgcn, 'shanxi2');
  assert.strictEqual(REGIONS.find(r => r.name === '山西').slugs.qiyoujiage, 'shanxi');
  assert.strictEqual(REGIONS.find(r => r.name === '山西').slugs.xmgcn, 'shanxi');
  assert.strictEqual(REGIONS.find(r => r.name === '内蒙古').slugs.qiyoujiage, 'neimenggu');
  assert.strictEqual(REGIONS.find(r => r.name === '内蒙古').slugs.xmgcn, 'namenggu');
  assert.strictEqual(REGIONS.find(r => r.name === '西藏').slugs.qiyoujiage, 'xizang');
  assert.strictEqual(REGIONS.find(r => r.name === '西藏').slugs.xmgcn, 'xicang');
});


/* ---------- 站点「拒绝访问」的识别与熔断 ---------- */

/**
 * 站点可能用「HTTP 200 + 错误页」拒绝访问。
 *
 * 2026-11-24 实测 xmgcn.com：请求任何路径都回 HTTP 200，
 * 正文却是 nginx 的 403 错误页（138 字节静态文件，last-modified 2025-06-05）。
 * 抓取层只看状态码就会当成「抓取成功」，然后报「解析不出字段」——
 * 排查方向会被引到解析器上，而真正的原因是**站点在拒绝我们**。
 */
const NGINX_403_PAGE =
  '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n' +
  '<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>';

function runNetworkSuite(label, sources) {
  const httpClient = require(path.join(ROOT, 'server', 'src', 'services', 'http-client'));

  check(label + ' 站点回「HTTP 200 + nginx 403 页」时要能认出来（别误判成解析失败）', () => {
    assert(httpClient.detectBlockPage(NGINX_403_PAGE), 'nginx 403 页应被识别');
    assert(httpClient.detectBlockPage('<html><title>502 Bad Gateway</title></html>'), '5xx 错误页应被识别');
    assert(httpClient.detectBlockPage('<html><title>Just a moment...</title></html>'), 'WAF 校验页应被识别');
    // 真实页面不能被误判
    const real = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'xmgcn-guangdong.html'), 'utf8');
    assert.strictEqual(httpClient.detectBlockPage(real), null, '真实省份页不能被误判');
    assert.strictEqual(httpClient.detectBlockPage(''), null, '空正文不算被拒');
    // 正文很长时就算出现关键词也不判（避免文章里写「安全验证」就误伤）
    assert.strictEqual(httpClient.detectBlockPage('<p>403 Forbidden</p>' + 'x'.repeat(5000)), null,
      '长正文不能判成错误页');
  });

  check(label + ' 连续被拒才熔断；熔断期不再请求；抓成功就解除', () => {
    httpClient.resetBlocked();
    assert.strictEqual(httpClient.isBlocked('src-a'), false, '一开始不该熔断');
    httpClient.markBlocked('src-a', '403 Forbidden');
    httpClient.markBlocked('src-a', '403 Forbidden');
    assert.strictEqual(httpClient.isBlocked('src-a'), false, '连着两次还不该熔断');
    httpClient.markBlocked('src-a', '403 Forbidden');
    assert.strictEqual(httpClient.isBlocked('src-a'), true, '第三次该熔断');
    assert.strictEqual(httpClient.blockedInfo('src-a').count, 3, '被拒次数要记着');
    httpClient.clearBlocked('src-a');
    assert.strictEqual(httpClient.isBlocked('src-a'), false, '抓成功后要解除熔断');
    httpClient.resetBlocked();
  });

  check(label + ' 口径互校源是内部源：它挂了不该点亮用户的「等待人工核对」', () => {
    const timeline = sources.SOURCES.find(x => x.id === 'xmgcn-timeline');
    assert(timeline, '缺少 xmgcn-timeline 来源');
    assert.strictEqual(timeline.internal, true, '时间表源应标成内部源');
    assert.strictEqual(timeline.provides.includes('price'), false, '它不提供用户侧数据');
    // 用户侧来源不能被标成内部源
    ['xmgcn', 'qiyoujiage', 'ndrc-notice'].forEach(id => {
      const s = sources.SOURCES.find(x => x.id === id);
      assert(s, '缺少来源 ' + id);
      assert.notStrictEqual(s.internal, true, id + ' 是用户侧来源，不能标成内部源');
    });
  });
}

for (const [label, sources] of IMPLS) {
  console.log('--- ' + label + ' 解析器 ---');
  runSuite(label, sources);
  console.log('--- ' + label + ' 国际行情 ---');
  runMarketSuite(label, sources);
  console.log('--- ' + label + ' 抓取层 ---');
  runNetworkSuite(label, sources);
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

/* ---------- 站点拒绝访问：端到端（本地假站点，不打真站点） ---------- */

/**
 * 起一个本地站点，**用 HTTP 200 回 nginx 的 403 错误页** ——
 * 与 2026-11-24 实测 xmgcn.com 的行为一模一样（状态码 200，正文是错误页）。
 *
 * 然后验证采集器两件事：
 *   1. 把这种响应认成「被拒」（SOURCE_BLOCKED），而不是「解析不出字段」——
 *      后者会把排查方向引到解析器上，而真正的原因是站点在拒绝我们；
 *   2. 连续被拒到阈值就熔断，之后**一个请求都不再发** ——
 *      31 省 × 2 次重试 = 62 个请求，别往拒绝我们的站点脸上打。
 */
async function blockedSite() {
  console.log('--- 站点拒绝访问（本地假站点）---');
  const http = require('http');
  const collector = require(path.join(ROOT, 'server', 'src', 'services', 'collector'));
  const httpClient = require(path.join(ROOT, 'server', 'src', 'services', 'http-client'));

  let hits = 0;
  const server = http.createServer(function (req, res) {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(NGINX_403_PAGE);
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const source = {
    id: 'blocked-site-test',
    name: '拒绝访问的假站点',
    url: 'http://127.0.0.1:' + port + '/tiaozheng/',
    // host 带端口：白名单比的是 host:port
    allowedHosts: ['127.0.0.1:' + port],
    headers: {}
  };

  try {
    httpClient.resetBlocked();
    const first = await collector.fetchSource(source);
    check('站点回 200 + 403 页时认成「被拒」，不是「解析不出字段」', () => {
      assert.strictEqual(first.ok, false);
      assert.strictEqual(first.reason, 'SOURCE_BLOCKED', JSON.stringify(first));
    });
    check('被拒原因里说清是站点在拒绝访问', () => {
      assert(first.message.indexOf('拒绝访问') >= 0, first.message);
    });

    // 再试两次 → 熔断
    await collector.fetchSource(source);
    await collector.fetchSource(source);
    check('连续被拒到阈值后熔断', () => {
      assert.strictEqual(httpClient.isBlocked(source.id), true);
    });

    const hitsBefore = hits;
    const cooled = await collector.fetchSource(source);
    check('熔断期不再请求该来源', () => {
      assert.strictEqual(cooled.ok, false);
      assert.strictEqual(cooled.reason, 'SOURCE_BLOCKED_COOLDOWN', JSON.stringify(cooled));
    });
    check('熔断期确实一个请求都没发出去', () => {
      assert.strictEqual(hits, hitsBefore, '请求数 ' + hitsBefore + ' → ' + hits);
    });
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
    httpClient.resetBlocked();
  }
}

Promise.resolve()
  .then(() => blockedSite())
  .then(() => (process.argv.includes('--live') ? live() : null))
  .then(() => {
    if (failures) {
      console.error('\n' + failures + ' 个用例失败');
      process.exit(1);
    }
    console.log('\n采集器验证全部通过');
  });