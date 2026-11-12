# 数据源接入说明

## 为什么现在是演示数据

设计文档写得很清楚：

> 正式开发前需要单独验证来源可访问性、字段稳定性、更新频率和授权条款；
> 无法自动解析时进入人工核对队列，不能把猜测值发布为正式结果。

这句话不是「先随便找个接口接上」，而是**在数据源没验证过之前，
先保证数据层是干净的**：结构对、计算对、来源可追溯、异常不装死。

现在的做法：

- 内置一套完整的演示数据集，覆盖 31 个省级行政区、4 个油品、24 次调价节点、
  4 条通知、Brent / WTI 行情，跑通全链路
- 数据层留好适配口，真实源只要实现同样的数据结构就能替换，页面代码一行不用改
- 演示数据的日期按「今天 - 锚点日」整体平移，一周后再打开看到的仍然是「最近发生的」

## 油价是怎么算出来的

现实中调价由国家机制统一发起，**调整幅度全国统一**，但**落地零售价按地区定价**。
所以数据模型是两层：

```
某地某油品价格 = 全国价(累加所有调价幅度) + 地区价差
```

代码位置：

- 小程序端：`data/adjustments.js`（调价时间线）、`data/regions.js`（地区价差）
- 云函数端：`cloudfunctions/_shared/shared.js`（同一份规则）

两端共用一套规则，靠 `scripts/sync-cloud-shared.js` 同步，因为云函数各自打包上传，
没法跨目录引用小程序根目录。

## 走势为什么画成阶梯线

国内成品油价格只在调价日变化，其余时间保持不变。画成连续折线等于伪造了一整条
「高频成交价」，和设计文档「不伪装成连续实时成交价」冲突。

所以 `utils/chart.js` 默认 `mode: 'step'`：横线表示价格保持不变，竖线表示调价那一刻
的跳变。横段宽度按真实日期比例分配，看起来就是真实的「平台期 + 跳变」。

国际行情那边是连续报价，用 `mode: 'line'`。

## 地区价差

`data/regions.js` 里每个地区一个 `offset`，单位元/升：

| 地区 | offset | 92# 当前价 |
| --- | --- | --- |
| 广东 · 广州 | 0.00 | 7.36 |
| 河南 · 郑州 | -0.02 | 7.34 |
| 北京 · 北京 | +0.05 | 7.41 |
| 上海 · 上海 | +0.13 | 7.49 |
| 海南 · 海口 | +0.15 | 7.51 |
| 黑龙江 · 哈尔滨 | -0.06 | 7.30 |

这些都是演示值。接真实数据后，`offset` 应该由采集端按各地实际挂牌价算出来，
而不是写死。

## 已接入的真实来源：汽油价格网（qiyoujiage）

2026-11-12 接入并验证，参考 [aalavender/OilPrice](https://github.com/aalavender/OilPrice)
与 [vikiboss/60s](https://github.com/vikiboss/60s) 的采集方式。

- **地区挂牌价**：`http://www.qiyoujiage.com/{slug}.shtml`，31 个省级地区页，
  slug 存在 `data/regions.js`（⚠️ 山西 `shanxi`、陕西 `shanxi-3`，拼音撞名）。
  解析 `#youjia` 区块的 `dl/dt/dd`，四油品（92/95/98/0#）缺一不可，
  价格超出 3–20 元/升合理区间整体转人工核对。
- **下次调价预测**：解析 `#EA5146` 边框提示 div 的「下次油价X月X日X时调整 /
  预计上调（下调/搁浅）X元/吨（X–X元/升）」。预测写 `oil_windows`，
  一律 `isOfficial: false`；来源只给整体升幅区间，四个油品共用区间中值，
  basis 注明非官方、以正式公告为准。页面不写年份，按「早 20 天以上即跨年」推断。
- **采集节奏**：价格只在调价日变化，默认 6 小时新鲜期（`freshHours`），
  31 省 3 并发抓取；`regionCode` / `force` 参数可单地区强制重采。
- **验证**：`node scripts/verify-collector.js`（fixture 回归，价格与
  `data/reference-prices.js` 独立来源逐值比对）；`--live` 追加真实抓取 +
  pg-mem 入库链路验证。fixture 快照在 `scripts/fixtures/`。
- 站点声明价格仅供参考，展示侧保留来源标注；ndrc-notice / market-quote
  两个来源仍未启用。

### 98# 的口径差异（不是解析 bug）

现抓的 98# 与 `data/reference-prices.js` 在个别省份对不上，例如
河南 10.75 vs 10.16、海南 12.05 vs 11.63。核对页面原文后确认**解析正确**，
差异来自不同来源的 98# 数据口径不同 —— 98# 铺货率低，各站数据源不一致。

所以 `verify-collector.js` 只对北京 / 陕西 / 云南三省做「fixture 与 reference 逐值比对」，
live 模式只断言结构与数值区间。**别把 live 值与 reference 的全量差异当成解析 bug。**

## 想加一个新数据源

1. 在 `cloudfunctions/oilCollector/sources.js` 加一条配置
   （`server/src/services/sources.js` 保持逐字节一致）
2. 在 `PARSERS` 里写解析器，**解析不出来就返回 null**，不要返回默认值
3. 在 `collectFromSource` 里按 `kind` 分发到对应的入库函数
4. 跑一次真实抓取，确认解析结果
5. 打开 `enabled`

改过 `data/` 下的真源文件之后要跑 `node scripts/sync-cloud-shared.js`
（`_shared/shared.js` 是生成产物，手改会被覆盖）。
