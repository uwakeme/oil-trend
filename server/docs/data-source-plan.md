# 多源协作 + 近一年历史油价 · 实施计划

> 设计见 `server/docs/data-source-design.md`（已提交 4f611cb）
> 本计划在当前会话内直接执行，每完成一个 Task 跑一次自检。

## 全局约束

- 直接在 `main` 上提交，提交信息用中文（`feat:` / `fix:` / `docs:` / `chore:`）
- 运行时代码可用 ES6，但**禁用可选链 `?.` 与空值合并 `??`**
- 注释用中文，文件头用 `/** */` 说明职责与关键约定
- **不发布猜测值**：解析不出结构化字段就进人工核对队列
- 真源在 `data/`，`server/src/shared/shared.js` 是生成产物 → 改完必须 `node scripts/sync-shared.js`
- 改完必须跑：`node scripts/lint-wxml.js`、`node scripts/check-modules.js`、`node scripts/verify-contract.js`、`node scripts/verify-data.js`、`node scripts/sync-shared.js`、`node scripts/verify-collector.js`、`cd server && npm test`
- **反向验证是硬要求**：拆掉任一闸门 → 对应用例变红 → 还原复跑全绿
- 提交信息含空格 → 写 `.tooling/commit-msg-N.txt` 再 `git commit -F`

## 已用真实数据定好的阈值

实测 31 省 × 31 期 × 4 油品 = 3844 个点后确定：

| 现象 | 数值 | 结论 |
| --- | --- | --- |
| 历史表行序 | **降序（最新在前）** | 解析后必须按日期升序重排 |
| 站点涨跌列 vs 相邻期价差 | 3220 样本只错 1 条（四舍五入） | **涨跌列可信**，可用 |
| 官方吨价 ↔ 92# 跨省变化中位数 | 26 轮比值恒定 1.07~1.18 | 两套独立数据互证通过 |
| 真实单轮最大变化 | 1.13（2026-03-24 的 98#，全国性大涨） | 跳变阈值不能低于 1.2 |
| 跨省离群点 | 24 / 3720 = 0.65%，集中在 98# | 跨省一致性判据用「变化中位数」，不用「绝对价」 |
| 98# 跨省绝对价差 | 自然离散可达 1.4 元/升 | **不能用绝对价判离群** |

---

### Task 1：地区路径名改成每源一套

**Files:**
- Modify: `data/regions.js`（31 条：`slug` → `slugs: { qiyoujiage, xmgcn }`）
- Modify: `server/src/services/collector.js`（新增 `regionSlug` / `regionUrl`）

**Interfaces:**
- Produces: `regionSlug(source, region) -> string`、`regionUrl(source, region) -> string`

- [ ] Step 1：`data/regions.js` 里 31 条改成 `slugs: { qiyoujiage: '<原 slug>', xmgcn: '<xmgcn slug>' }`
  3 个省不同：内蒙古 `neimenggu`→`namenggu`、陕西 `shanxi-3`→`shanxi2`、西藏 `xizang`→`xicang`
- [ ] Step 2：collector 里加
  ```js
  function regionSlug(source, region) {
    var slugs = region.slugs || {};
    return slugs[source.id] || region.slug || '';
  }
  function regionUrl(source, region) {
    var tpl = source.urlTemplate || (source.url + '{slug}');
    return tpl.replace('{slug}', regionSlug(source, region));
  }
  ```
- [ ] Step 3：`node scripts/sync-shared.js` → 断言全过
- [ ] Step 4：提交 `refactor: 地区路径名改成每源一套`

### Task 2：xmgcn 源配置与解析器

**Files:**
- Modify: `server/src/services/sources.js`
- Test: `scripts/verify-collector.js`

**Interfaces:**
- Produces: `PARSERS.xmgcnRegion(raw) -> { prices, changes, history } | null`
  - `history`：`[{ date: 'YYYY-MM-DD', prices: {92,95,98,0}, changes: {} }]`，**按日期升序**
  - 解析不出四油品现价、或历史行数 < 20（残页）→ 返回 `null`

- [ ] Step 1：源配置
  ```js
  {
    id: 'xmgcn', name: '油价网', kind: 'price', enabled: true,
    priority: 1, provides: ['price', 'history'],
    url: 'https://www.xmgcn.com/',
    urlTemplate: 'https://www.xmgcn.com/{slug}/',
    allowedHosts: ['www.xmgcn.com'],
    headers: { 'User-Agent': '...' },
    parser: 'xmgcnRegion', freshHours: 6,
    note: '各省历史挂牌价表（最近 30 期）与当前价。HTTPS。'
  }
  ```
  qiyoujiage 改成 `kind: 'forecast'`、`priority: 2`、`provides: ['forecast','price']`、
  加 `urlTemplate: 'http://www.qiyoujiage.com/{slug}.shtml'`、
  加 `verifyRegions: ['440000','370000','650000']`
- [ ] Step 2：写 `xmgcnRegion` 解析器
  - 现价：按 `<div class="price-card n(d+)"` 切段，取 `price-value` / `price-change`
  - 历史：`history-table` 里的表，**表头驱动列映射**（`<th>92号汽油</th>` → 油品 id）
  - 每行取 `price-cell` 里的第一个数字为价格、`change-cell` 里的带符号数为涨跌
  - 行按日期升序排序
- [ ] Step 3：`scripts/verify-collector.js` 加解析用例（真实 HTML 片段夹具）
- [ ] Step 4：跑 `node scripts/verify-collector.js` → 全过
- [ ] Step 5：提交 `feat: 接入油价网历史挂牌价源`

### Task 3：价格源降级链 + 预测流程

**Files:**
- Modify: `server/src/services/collector.js`

**Interfaces:**
- Produces: `collectPriceChain(priceSources, options) -> result`
- Produces: `collectForecastSource(source, options) -> result`

- [ ] Step 1：`fetchRegionPrices(source, regions, cache)` —— 3 并发 + 每请求间隔 800ms +
  **解析失败重试 1 次**（xmgcn 密集请求会返回空 tbody）
- [ ] Step 2：`collectPriceChain` —— 按 `priority` 顺序逐省降级：
  前一个源成功的省不再问后面的源；两个都失败的省进人工核对队列
- [ ] Step 3：`collectForecastSource` —— 抓 `verifyRegions` 三个省：
  ① 第一个解析成功的 `trend` → `saveWindow`；② 三省现价跟库里现价交叉校核，偏差 > 0.02 记告警不阻断
- [ ] Step 4：`run()` 编排：价格链 → 预测 → 公告
- [ ] Step 5：提交 `feat: 价格源按优先级降级，预测源独立成流程`

### Task 4：历史入库闸门

**Files:**
- Modify: `server/src/services/collector.js`（新增 `saveHistory`）

**Interfaces:**
- Produces: `saveHistory(source, parsed, region) -> { ok, saved, dropped, advisories }`

- [ ] Step 1：G1 区间 3 ≤ price ≤ 20 → 丢点 + 告警
- [ ] Step 2：G2 日期去重与排序
- [ ] Step 3：G3 首尾自洽：历史首行价格 == 同页现价 → 不等则**历史整省丢弃 + 告警**（现价照常入库）
- [ ] Step 4：G4 跨省变化一致性（同日期同油品，跨省变化中位数 + MAD）
  偏离 > `max(0.15, 4×MAD)` → **标记 + 告警，保留原值**（源站值不是猜测值，不该替它改）
  → 需要所有省解析完再统一做，不能边抓边写
- [ ] Step 5：`oil_prices` 与 `oil_price_history` 落库（history 带上今天那一行，保证 30 天走势有端点）
- [ ] Step 6：`server/scripts/selftest.js` 加 5 道闸门用例
- [ ] Step 7：**反向验证**：逐个拆闸门 → 用例变红 → 还原
- [ ] Step 8：提交 `feat: 历史价入库加五道闸门`

### Task 5：调价节点从历史推导

**Files:**
- Modify: `server/src/services/collector.js`
- Modify: `server/src/services/query.js`（`actionTrend` 合并官方公告与推导节点）

- [ ] Step 1：collector 里按跨省变化中位数推导每轮调价的四油品实测幅度，写 `oil_adjust_events`
- [ ] Step 2：`actionTrend` 合并：官方公告优先（title/方向/官方吨价），没有公告的轮次用推导节点补
- [ ] Step 3：走势页 1y 视图节点数从 0 变成 ~30
- [ ] Step 4：提交 `feat: 调价节点从历史实测推导，全年节点补齐`

### Task 6：来源标注与口径

**Files:**
- Modify: `server/src/services/query.js`（`payload.source.note`）
- Modify: `utils/format.js`（`MEASURED_NOTE` 保持「实测」口径，不出现「官方公布」）

- [ ] Step 1：note 写成「历史价来自油价网（xmgcn），覆盖 N 期 · 调价幅度据各省挂牌价实测」
- [ ] Step 2：`node scripts/verify-contract.js` → 107 项全过
- [ ] Step 3：提交 `feat: 走势页标注历史数据来源与实测口径`

### Task 7：全量自检、提交推送、线上核验

- [ ] Step 1：全量自检全绿
- [ ] Step 2：提交推送，`git ls-remote` 核对
- [ ] Step 3：CI 部署后核验 `/api/trend?period=1y` 返回多期点位、`/api/home` 走势卡有横线
- [ ] Step 4：模拟器逐页核对 + 截图入库
- [ ] Step 5：AGENTS.md 补踩坑记录
