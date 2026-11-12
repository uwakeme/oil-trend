# 油势

一个查油价的小程序。看本地油价、等下一轮调价、顺手设个降价提醒。

功能和页面照着 `design/product-design.md` 做的，界面从 `design/oil-price-prototype.html` 移植过来。
一级页面五个：油价、走势、调价、国际、提醒。

## 现在是什么状态

前端五个页面都写完了，在开发者工具模拟器里逐页跑过并截图核对过。

**后端已上线**：`server/`（Node + Express + PostgreSQL）部署在
`https://oil-trend.uwakeme.top`，采集器每 30 分钟从**汽油价格网**抓 31 个
省级行政区的挂牌价（92#/95#/98#/0#）。页面显示的是真实挂牌价。
部署步骤见 [docs/server-deploy.md](docs/server-deploy.md)。

预览二维码已经能出了（AppID 填在本地的 `project.private.config.json` 里，仓库中不保留）。

订阅消息这条路还没走通到底。模板 ID 要在公众平台申请（`subscribeTemplateIds` 与服务端
环境变量 `OIL_SUBSCRIBE_TEMPLATE_ID` 填同一个值）。
所以「提醒」页在没配模板时会明说「订阅消息未配置」，不会假装授权成功。

## 快速开始

用微信开发者工具打开这个目录，直接编译。

`project.config.json` 里的 appid 是占位的 `touristappid`。
**真实 AppID 放在本地 `project.private.config.json`**（该文件不入版本控制），
开发者工具会把它合并覆盖到工程配置上。

**AppSecret 不要进代码** —— 小程序包里放密钥会被上传泄露。
这个项目的前端也不需要它：AppSecret 只放在服务器的 `server/.env` 里。

基础库版本：工程配置写 3.8.10，本地 `project.private.config.json` 也写 3.8.10，
登录开发者工具后会自动下载。

## 出预览二维码

预览包要上传到平台，**必须用正式 AppID**，测试号会被平台拒掉（`AppID 不合法`）。
注册好油势专属的小程序后，一条命令搞定：

```bash
node scripts/preview-qr.js wx你的AppID
```

它会把 AppID 写进**本地私有的** `project.private.config.json`（入库的
`project.config.json` 只留 `touristappid` 占位符），再调开发者工具 CLI 上传预览包，
最后把终端字符二维码渲染成可扫码的 PNG，输出到 `docs/preview-qr.png`。
开发者工具要事先登录；主包不能超过 2MB（`packOptions.ignore` 已排除非运行文件）。

换一个 AppID 之后要重新跑这条命令：预览包是按 AppID 上传的，
旧的二维码会指向已经不存在的账号。

## 目录

```
oil_trend/
├── app.js / app.json / app.wxss
├── pages/              五个页面
├── components/
│   ├── trend-chart/    Canvas 2D 价格曲线
│   └── bottom-sheet/   底部弹层
├── data/               演示数据集、调价时间线、地区价差
├── utils/              api / chart / store / format / cloud / subscribe
├── styles/             设计令牌与通用组件类
├── server/             后端（Node + Express + PostgreSQL）
├── scripts/            构建与自检脚本
└── docs/
```

## 页面

| 页面 | 关键内容 |
| --- | --- |
| 油价 | 92# 大卡 + 92/95/98/0 固定顺序小卡、下一轮调价窗口、近 30 天走势、最新调价通知 |
| 走势 | 油品与周期切换、阶梯线图、调价节点列表（涨红跌绿） |
| 调价 | 下一轮窗口卡、采集同步状态、正式结果与市场预测分栏、通知详情 |
| 国际 | Brent / WTI 切换、分时曲线、开盘/昨收/最高/最低、延时标注 |
| 提醒 | 订阅状态、官方降价开关、目标价步进、预测提醒（默认关）、历史记录 |

## 油价是怎么算出来的

调价幅度全国统一，落地零售价按地区定价。所以拆成两层：

```
某地某油品价格 = 全国价（累加所有调价幅度）+ 地区价差（该地区、该油品）
```

地区价差**按油品分别存**：现实中各省的标号结构不一样 ——
98# 相对 92# 的溢价，各省从山西的 -0.15 到甘肃的 +1.17，差 1.3 元/升；
柴油相对 92# 的差额同样分化。用一套价差套四个油品，98# 的误差最大能到 0.9 元/升。

演示数据集里有 24 次调价节点、31 个省级行政区、4 个油品。广东 92# 当前 8.91 元/升，
最近一次是 11 月 2 日下调 0.08。走 3 个月区间能看到 6 个调价节点。

地区价差按各省公布的最高零售价算（2026-10-29 那轮），
所以算出来的价格与各地发改委挂牌价一致。基准值在 `data/reference-prices.js`，
自检会逐省比对。

更细的说明在 [docs/data-sources.md](docs/data-sources.md)。

## 接真实数据

`utils/api.js` 是唯一取数入口。它先调后端（`utils/cloud.js` → `config.apiBaseUrl`），
失败或者没配后端地址就回落本地演示源。
回落这件事对页面是透明的，但首页右上角齿轮里会写明当前数据来源，不含糊。

换数据来源改 `server/src/services/sources.js`（采集器配置）。
解析器解析不出结构化字段时会转人工核对队列，不会把猜测值发布成正式结果。

## 脚本

```bash
node scripts/verify-data.js       # 打印数据层算出的价格、走势、通知、行情
node scripts/lint-wxml.js         # 检查 WXML 绑定、事件、样式类、标签闭合
node scripts/check-modules.js     # 运行时模块逐个 require 一遍，挡加载期 ReferenceError
node scripts/build-icons.js       # 重生成 PNG 图标（SVG 精灵内联在脚本里）
node scripts/sync-shared.js       # 由 data/ 生成服务端共享模块并做一致性断言
node scripts/preview-qr.js         # 上传预览包并生成扫码图
node scripts/verify-in-devtools.js # 逐页截图 + 运行时异常捕获（需 IDE 自动化服务）
cd server && npm test              # 自建后端自检（40 项结构 + 26 项 HTTP）
```

`lint-wxml.js` 那个检查器抓出过两个真 bug：tabBar 在 `wx:for` 里写了 `{{path}}`
（应为 `{{item.path}}`），以及 `<br>` 不是 WXML 内置标签导致整页编译失败。
验证过程和另外几个坑记在 [docs/verification.md](docs/verification.md)。

`scripts/verify-in-devtools.js` 是连开发者工具模拟器逐页截图用的，需要先装依赖：

```bash
npm i --prefix .tooling ws
node scripts/verify-in-devtools.js
```

## 还没做的

订阅消息的真机联调（需正式模板 ID）。
调价公告（ndrc）与国际行情两个采集源仍未启用，`oil_windows` 的预测来自汽油价格网。

页面 WXSS 里还有 42 处硬编码色值没走 `styles/tokens.wxss` 的设计令牌（纯样式一致性，不影响功能）。
