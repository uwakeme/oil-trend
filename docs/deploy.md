# 云开发部署指南

油势的云端分三个云函数：读数据、采数据、发提醒。前端只认 `utils/api.js` 暴露的结构，
数据从哪来对页面是透明的。

| 云函数 | 职责 | 触发方式 |
| --- | --- | --- |
| `oilApi` | 给小程序提供油价 / 走势 / 通知 / 行情，以及保存提醒规则与记录 | 小程序端主动调用 |
| `oilCollector` | 定时抓取官方公告与国际行情，解析后去重入库 | 定时触发器（默认每 30 分钟） |
| `oilAlert` | 匹配提醒规则并下发微信订阅消息 | 定时触发器（默认每 30 分钟） |

## 一、准备

1. 换成正式小程序 AppID（`project.config.json` 的 `appid`），测试号不能开云开发，也不能发订阅消息。
2. 在开发者工具里开通云开发，拿到环境 ID。
3. 上传小程序头像：公众平台 →「设置」→「基本设置」→「头像」，用 `assets/app-icon/app-icon.png`（512×512 正方形，78KB）。
4. 把环境 ID 填进 `config/index.js`：

```js
module.exports = {
  cloudEnvId: 'your-env-id',
  subscribeTemplateIds: ['你的模板ID'],
  dataSource: 'auto'
};
```

## 二、部署云函数

在开发者工具的云函数面板里，依次对 `cloudfunctions/oilApi`、`cloudfunctions/oilCollector`、
`cloudfunctions/oilAlert` 三个目录执行「上传并部署：云端安装依赖」。

部署前先跑一次同步脚本，让三个云函数拿到同一份共享规则：

```bash
node scripts/sync-cloud-shared.js
```

## 三、建集合

云数据库里建好这些集合。

**权限统一设成「仅管理端可读写」**：小程序端不直连数据库，所有读取都走 `oilApi` 云函数；
`alert_rules` / `alert_logs` 里存着 openid 和用户自己的提醒规则，
设成「所有用户可读」会泄露他人的数据。

- `oil_prices` 当前价，每个 `(regionCode, fuelId)` 一条
- `oil_price_history` 历史价，每个 `(regionCode, fuelId, date)` 一条
- `oil_adjust_events` 调价节点，每次调价一条
- `oil_notices` 调价通知，带 `dedupKey` 去重
- `oil_windows` 下一轮调价窗口
- `oil_markets` 国际行情
- `alert_rules` 提醒规则，按 `userId`（openid）查
- `alert_logs` 提醒记录，按 `userId` 查
- `oil_users` 用户标识
- `collector_runs` 采集运行记录，前端用它显示「同步状态」

## 四、先把演示数据灌进云端

真实数据源启用前，云数据库是空的，前端会拿到空数据。在云函数面板手动运行
`oilCollector`，传参 `{"action":"seed","confirm":"seed"}`，会写入一套演示数据，用来验证云端链路是通的。

seed 只会清掉带 `source: 'seed'` 标记的演示数据，不会碰采集器写进来的真实数据；
但仍然要显式传 `confirm`，避免误触发。

## 五、接入真实数据源

编辑 `cloudfunctions/oilCollector/sources.js`：

```js
{
  id: 'ndrc-notice',
  name: '国家发展改革委价格监测中心',
  kind: 'notice',
  enabled: true,        // ← 默认 false
  url: 'https://...',
  headers: {},
  parser: 'ndrcNotice'
}
```

启用前必须确认三件事：

1. 地址能稳定访问（是否要 Referer、Cookie，有无频率限制）
2. 抓取和展示不违反对方使用条款
3. parser 写得对，跑一次真实抓取，看解析结果是不是符合预期

解析器解析不出结构化字段时，采集函数**不会猜**，而是把这次采集标记为
`needsReview` 写进 `collector_runs`，前端会显示「等待人工核对」。
这条是硬约束：宁可不更新，也不能把猜测值发布成正式结果。

## 六、订阅消息

1. 在微信公众平台申请订阅消息模板，拿到模板 ID。
2. 模板字段要和 `cloudfunctions/oilAlert/index.js` 里 `TEMPLATE_FIELDS` 的映射对上，
   字段名不一致会下发失败。
3. 把模板 ID 填进 `config/index.js` 的 `subscribeTemplateIds`（小程序端发起授权要用），
   并在云函数 `oilAlert` 的环境变量里配 `OIL_SUBSCRIBE_TEMPLATE_ID`（服务端下发要用）。
   两处是同一个模板 ID，云函数不再在代码里手填模板 ID，漏配只会报明确错误而不是静默失败。
4. 联调开发版/体验版时，把云函数环境变量 `OIL_MINIPROGRAM_STATE` 设成 `developer` 或 `trial`；
   正式发布留空即可（默认 `formal`）。

下发链路：用户在「提醒」页点「去开启」→ 小程序调 `wx.requestSubscribeMessage`
→ 授权结果写回 `alert_rules.subscribeGranted` → `oilAlert` 定时扫规则 → 命中后调用
`cloud.openapi.subscribeMessage.send`。

同一个「规则 + 事件」只会发一次，靠 `alert_logs.dedupKey` 保证。

## 七、怎么确认它跑通了

- 数据来源：首页右上角齿轮 →「数据来源与说明」里会显示当前是云端还是本地演示数据
- 采集状态：「调价」页顶部那一行。真实来源没启用时显示「真实数据源尚未接入」，
  解析失败待复核显示「等待人工核对」，只有真的采集成功才显示「自动同步正常」
- 提醒下发：看 `alert_logs` 里 `sent` 字段，失败会有 `failReason`
