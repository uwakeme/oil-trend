# 数据源重构：多源协作 + 近一年历史油价

> 状态：设计已确认（2026-11-16），待实施
> 影响面：`server/src/services/sources.js`、`server/src/services/collector.js`、`data/regions.js`
> 不改：数据库表结构、小程序端代码、`utils/api.js`

## 1. 要解决的问题

首页与走势页的历史价只有 **5 个点**（全在 2026-11-12 ~ 11-16），因为采集器
2026-11-12 才上线、且只写「当天生效价」。结果是：

- 走势图的 3m / 6m / 1y 三个周期返回的是同一组 5 个点（只有坐标轴不同），
  一年图只有最右侧一小段台阶；
- 走势页的「调价节点数」恒为 0（`oil_adjust_events` 生产库一直是空的）；
- 「四油品每升幅度测算」只能拿到本轮前后的快照，历史轮的幅度全空。

用户诉求：**补足近一年数据，让走势图画得出来。**

## 2. 源调研结论（2026-11-16 实测）

| 源 | 协议 | 现价 | 历史 | 下次调价预测 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `qiyoujiage.com` 汽油价格网 | **HTTP** ✗ | ✓ | ✗ | ✓ | 唯一有预测，但无 HTTPS、无历史 |
| `xmgcn.com` 油价网 | **HTTPS** ✓ | ✓ | ✓ 30 期 | ✗ | **主源** |
| `youjia.yuntongcha.com` | HTTP ✗ | ✓ | ✓ | ✗ | xmgcn 同源镜像，做兜底 |
| `qiyoujiage.com/tz/` | HTTP | — | 数据停在 2024-12-18 | — | 站点陈旧，弃用 |
| `xmgcn.com/tiaozheng/` | HTTPS ✓ | — | 51 行官方吨价时间表 | — | 独立备份源，可校验方向 |
| `ndrc.gov.cn` 发改委 | HTTPS ✓ | — | — | 正式公告 | 已在用，不动 |

### 2.1 xmgcn 省份页结构

省份索引页 `https://www.xmgcn.com/{slug}/` 一个页面同时给出现价与历史：

```
<div class="price-card n92">
  <div class="oil-name">92号汽油</div>
  <div class="price-main">
    <span class="price-value">8.39</span>
    <span class="price-unit">元/升</span>
    <span class="price-change down"> -0.52 </span>
  </div>
</div>
...
<div class="history-table">
  <table>
    <thead><tr><th>日期</th><th>89号汽油</th><th>92号汽油</th><th>95号汽油</th><th>98号汽油</th><th>0号柴油</th></tr></thead>
    <tbody>
      <tr><td>2026-11-13</td>
          <td class="price-cell"><div>7.79</div><div class="change-cell change-down">-0.48</div></td>
          ...</tr>
    </tbody>
  </table>
</div>
```

要点：

- 油品 class 是 `n89 / n92 / n95 / n98 / n0`，**结构化、无歧义**；
- 历史表每行是「日期 + 各油品（价格 + 涨跌）」；
- 31 省页面结构完全一致；
- 89# 汽油在内蒙古/吉林/新疆/河南/湖北/辽宁/黑龙江是 `-`（这 7 省不供 89#），
  本项目只做 92/95/98/0，不受影响。

### 2.2 覆盖度与可信度（实测）

- **31 / 31 省**全部拿到表，每省 **31 行**，覆盖 **2025-09-10 → 2026-11-13**（30 轮调价）；
- 换算成入库行数：`31 省 × 31 期 × 4 油品 = 3844 条`；
- 广东 92# 历史表最新值 **8.39** = 广东省发改委公布的每升价，涨跌 **−0.52** = 线上测算值；
- **31 省最新价 vs 线上现价：差异 0.00，31/31 全对**；
- 这些是**各省公布的最高零售价本身，不是推算值**。原先设想的「官方吨价反推每升」
  （系数 92#≈0.00080 / 95#≈0.000855 / 98#≈0.00097 / 0#≈0.00081）作废 ——
  有真实数据就不拿推算冒充。

### 2.3 已知脏数据与坑

| 坑 | 表现 | 应对 |
| --- | --- | --- |
| 密集请求返回残页 | 表格 `<tbody>` 为空（首测 7/31 省失败） | 限速 + 行数校验 + 重试 |
| 源站数据本身有脏值 | 湖北 98# 某轮涨跌 −0.36，明显偏离各省中位数 | 跨省一致性闸门（MAD） |
| 源站偶尔漏更 | 某些省某个油品的价格停在旧值 | 序列跳变闸门 + 区间定界 |
| slug 与本项目不同 | 西藏=xicang、内蒙古=namenggu、陕西=shanxi2（其余 27 省同名） | 每源一套 slug 映射 |
| xmgcn 无预测 | 页面没有「下次调价预测」 | 预测仍由 qiyoujiage 独家提供 |

## 3. 职责划分

一个源不再等于一种数据，而是按**职责**声明能提供什么：

| 源 | kind | provides | 抓取量 | 协议 |
| --- | --- | --- | --- | --- |
| `xmgcn` 油价网 | `price` | price + history | 31 省 × 1 次（一次请求同时给现价与 30 期历史） | HTTPS ✓ |
| `qiyoujiage` 汽油价格网 | `forecast` | forecast + price（兜底/校核） | 平时抽 3 省；主源某省失败才按需补该省 | HTTP ✗ |
| `ndrc-notice` 发改委 | `notice` | notice | 不变 | HTTPS ✓ |

- **xmgcn 是现价与历史的唯一真源** —— 两者同源同页，天然自洽；
- **qiyoujiage 只保留三件事**：① 下次调价预测（全网唯一）；② 主源失败时的现价兜底；
  ③ 交叉校核；
- 交叉校核抽查 **广东 / 山东 / 新疆** 3 省（南 / 东 / 西，各省价差各异，异常更容易露出来），
  校核对的是「qiyoujiage 现价 vs 库里 xmgcn 现价」，**偏差 > 0.02 元/升 记告警但不阻断**；
- 请求量：31（xmgcn）+ 3（qiyoujiage 抽查）= 34 次/轮，比现状（31 次）只多 3 次，
  却换来 14 个月历史 —— 性价比最高。

## 4. 采集编排与降级

```
价格源组（按 priority 排序）：xmgcn(1) → qiyoujiage(2)
  逐省：xmgcn 成功 → 采用
        xmgcn 失败 → 该省交给 qiyoujiage 补
        两个都失败 → 该省转人工核对（不显示任何猜测值）
预测：qiyoujiage 抽 3 省 → 取第一个解析成功的 trend → oil_windows
校核：qiyoujiage 抽的 3 省现价 vs 库里的 xmgcn 现价 → 偏差告警
```

节流：3 并发 worker + 每请求间隔 800ms + **历史表行数 < 20 判定为残页 → 重试 1 次**。

## 5. 数据落库

| 表 | 写入方 | 内容 |
| --- | --- | --- |
| `oil_prices` | xmgcn（qiyoujiage 仅兜底时） | 当前价，`source` 标记来源 |
| `oil_price_history` | xmgcn | 30 期历史价，`source='xmgcn'`，按 (region,fuel,date) 幂等 upsert |
| `oil_windows` | qiyoujiage | 下次调价预测（`isOfficial=false`） |
| `oil_adjust_events` | xmgcn | **新增**：从历史价的变化点推导调价节点，`source='xmgcn'` |

`oil_adjust_events` 原来一直是空的（公告只给吨价、不给每升幅度，`saveAdjustEvent`
拿不到 `deltas` 就写不进去）。有了历史实测值，每个调价日都能算出**实测**的每升幅度，
走势页的「N 次调价」不再恒为 0。

⚠️ 口径：这些幅度是**各省挂牌价的实测差值**，不是官方公布值。展示层必须写明
「据各省挂牌价实测」，不能写成官方公布值（与 `utils/format.js` 的 `MEASURED_NOTE` 一致）。

## 6. 历史数据入库闸门（5 道）

源站有脏值，且历史是**一次性回填**（库里没有旧值可比），不能用「与上次采集价落差」
那套逻辑。历史单独设闸门：

| 闸门 | 判据 | 动作 |
| --- | --- | --- |
| G1 区间 | 3 ≤ price ≤ 20 元/升 | 丢点 + 告警 |
| G2 序列跳变 | 同省同油品相邻两期 \|Δ\| > 1.0 元/升 | 丢点 + 告警（正常一轮调价 ≤ 0.6） |
| G3 首尾自洽 | 历史表首行价格 == 同页现价 | 不等 → **整省丢弃**（说明解析错位） |
| G4 跨省一致性 | 同日同油品偏离各省中位数 > max(0.5, 3×MAD) | 丢点 + 告警 |
| G5 时序 | 日期单调递增、无重复 | 丢点 + 告警 |

G4 需要跨省数据，必须**所有省解析完再统一校验**，不能边抓边写。

## 7. 界面呈现

不新增组件。走势页与首页已有来源条机制（`fmt.sourceLine(payload.source)`），
在后端 `payload.source.note` 里写清：

> 历史价来自油价网（xmgcn），覆盖 2025-09-10 起 30 期 · 调价幅度据各省挂牌价实测

调价节点的文案统一走 `MEASURED_NOTE` 口径，不出现「官方公布」字样。

## 8. 改动清单

| 文件 | 改动 |
| --- | --- |
| `data/regions.js` | `slug`（单站路径名）→ `slugs: { qiyoujiage, xmgcn }`（每源一套） |
| `server/src/services/sources.js` | 新增 `xmgcn` 源配置；新增 `xmgcnRegion` 解析器；源配置加 `priority` / `provides` / `urlTemplate` / `verifyRegions` |
| `server/src/services/collector.js` | 价格源降级编排；`kind='forecast'` 流程；历史入库 5 道闸门；调价节点从历史推导 |
| `scripts/sync-shared.js` | 产物自动跟随 `data/regions.js`（整对象拷贝，无需改） |
| `scripts/verify-collector.js` | 新增 xmgcn 解析夹具与闸门回归 |
| `server/scripts/selftest.js` | 新增闸门 / 校核 / 降级用例 |

`server/src/shared/shared.js` 是生成产物，改完 `data/` 必须重跑 `node scripts/sync-shared.js`。

## 9. 测试与验证

- **解析夹具**：用真实 HTML 片段（已抓到结构）覆盖 —— 现价块、历史表、89# 缺失省、
  残页（tbody 空）、脏值行；
- **5 道闸门**各一个用例，逐一断言丢点/告警行为；
- **交叉校核**：两源偏差 > 0.02 → 告警不阻断；
- **降级**：主源某省失败 → 备源接管该省现价；
- **反向验证（硬要求）**：拆掉任一闸门 → 对应用例必须变红 → 还原复跑全绿；
- **全量自检**：`lint-wxml` / `check-modules` / `verify-contract` / `verify-data` /
  `sync-shared` / `verify-collector` / `server npm test` 全绿；
- **线上**：部署后 `/api/trend?period=1y` 返回多期点位，`/api/home` 走势卡有横线。

## 10. 不做的事（YAGNI）

- 不引入「官方吨价反推每升」的推算模型 —— 有真实数据；
- 不抓 `xmgcn.com/tiaozheng/` 的官方调价时间表做第二条历史链路 —— 一个源够了，
  留作日后方向校验的备份；
- 不做 `youjia.yuntongcha.com` 镜像接入 —— 与 xmgcn 同源，只是 HTTP 版本；
- 不改数据库表结构、不改小程序端；
- 不引入「按省分别配置采集频率」这类配置项。
