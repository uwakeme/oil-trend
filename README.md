<a id="readme-top"></a>

<div align="center">
  <img src="./assets/banner.svg" alt="Wake油价势助手 · 微信油价与调价提醒小程序" width="100%">
</div>

# Wake油价势助手

<div align="center">

**查本地油价 · 等下一轮调价 · 设降价提醒**

原生微信小程序，五个一级页面。打开先看现在多少钱、下一轮涨还是跌，想设提醒再去提醒页。

</div>

<div align="center">

[![Version][version-shield]][version-url]
[![License][license-shield]][license-url]
[![Stars][stars-shield]][stars-url]
[![Forks][forks-shield]][forks-url]
[![Issues][issues-shield]][issues-url]
[![Backend][backend-shield]][backend-url]

</div>

<details>
<summary>目录</summary>

- [项目简介](#项目简介)
- [界面](#界面)
- [功能](#功能)
- [快速开始](#快速开始)
- [油价怎么算](#油价怎么算)
- [后端与接口](#后端与接口)
- [数据采集](#数据采集)
- [开发脚本](#开发脚本)
- [部署](#部署)
- [发版到微信平台](#发版到微信平台)
- [已知限制](#已知限制)
- [License](#license)
- [参考资料](#参考资料)

</details>

## 项目简介

Wake油价势助手是给车主用的油价小程序。打开就是本地 92# 的挂牌价、下一轮调价窗口和最近 30 天的走势，还能写一条「降到 7.5 就提醒我」的规则。

国内成品油价格有两条规矩决定了它的数据形态：调价幅度全国统一，落地零售价按地区定价。所以价格拆成两层算，地区价差按油品分开存，原因见[油价怎么算](#油价怎么算)。

后端不可用时，页面直接显示失败态并给出重试按钮 —— **没有本地兜底**。内置演示数据已全部删除：宁可告诉用户「读不到」，也不给一份看起来很正常、其实是编出来的价格。

## 界面

<div align="center">

<img src="./docs/screenshots/01-price-home.png" alt="油价首页：92# 主价格卡、四个油品小卡、预计下次调价窗口（含下次通知时间）与近 30 天走势" width="30%" />

<img src="./docs/screenshots/02-trend.png" alt="走势页：阶梯线价格图与调价节点列表" width="30%" />

<img src="./docs/screenshots/03-notice.png" alt="调价页：预计下次调价窗口与下次通知时间、正式结果与市场预测分栏" width="30%" />

<br />

<img src="./docs/screenshots/04-global.png" alt="国际页：Brent 与 WTI 行情曲线" width="30%" />

<img src="./docs/screenshots/05-alert.png" alt="提醒页：订阅状态、降价规则与历史记录" width="30%" />

<img src="./docs/screenshots/02-trend-crosshair.png" alt="走势页：点选走势图后出现的十字光标与读数气泡" width="30%" />

<img src="./docs/screenshots/01-home-crosshair.png" alt="首页近 30 天迷你走势：点选后的一行读数" width="30%" />

<img src="./docs/screenshots/04-global-crosshair.png" alt="国际页：点选行情曲线后的十字光标与读数（精确到分钟）" width="30%" />

</div>

<p align="center"><sub>截图由开发者工具自动化服务抓取，含 Canvas 图表图层。</sub></p>

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 功能

- 首页把 92# 放在大卡，95#、98#、0# 按固定顺序排成小卡，不跟着点击顺序重排
- 切换大卡油品时，调价幅度、近 30 天走势、最新通知里的油品和金额一起换
- 走势图画阶梯线：横段是价格不变的调价周期，竖线是调价那一刻的跳变
- 走势图上点一下就出十字光标：竖线对日期、横线对价格，读出那一格的准确价格；拖动可以逐日扫，再点一次收起
- 调价页把正式公告和市场预测分成两栏，不只靠颜色区分，预测一律标「非官方」
- 调价窗口和调价通知都标出「预计下次调价」和「下次通知」时间：来源还没公布下一轮时按 10 个工作日周期推算，并明确写「推算 · 非官方」；发改委公告一般在调价当天上午发布，所以下次通知和下次调价是同一天
- 国际页固定写明单位是美元/桶，行情延时多少分钟也照实标出来
- 国际行情页同样能点选读数，日内 15 分钟一个点，读数精确到分钟
- 提醒页可以写「官方降价就提醒我」，也能设目标价和单次降幅门槛，预测提醒默认关掉
- 首次打开会请求一次位置权限，识别到所在省份就自动切到当地油价；手动选过地区的用户不会被自动覆盖
- 地区弹层顶部有「当前位置」，随时能重新定位；定位失败会写明原因，被拒过权限还能一键去设置里开
- 采集解析不出结构化字段时进人工核对队列，不会把猜测值发布成正式结果

## 快速开始

### 需要什么

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| 微信开发者工具 | 2.02.2609250 或更新 | 编译与预览 |
| 基础库 | 3.8.10 | 运行时 |
| Node.js | 18 或更新 | 只给脚本和后端用，小程序本身没有构建步骤 |
| PostgreSQL | 15 或更新 | 后端数据库，可选 |

### 跑起来

```bash
git clone https://github.com/uwakeme/oil-trend.git
cd oil-trend
```

用微信开发者工具打开这个目录，直接编译。前端没有任何 npm 依赖，也不需要打包。

> [!IMPORTANT]
> `project.config.json` 里存的是占位 AppID `touristappid`。真实 AppID 写在本地的 `project.private.config.json`（不入版本控制），开发者工具会把它合并到工程配置上。

> [!WARNING]
> AppSecret 绝不能进代码或小程序包。这个项目的前端也不需要它，AppSecret 只放在服务器的 `server/.env` 里。

### 起后端（必需）

小程序的一切数据都来自这个后端。不配 `apiBaseUrl` 就等于没有数据源，页面一律显示读取失败。

```bash
cd server
npm install
cp .env.example .env
npm start
```

```js
// config/index.js
module.exports = {
  apiBaseUrl: 'https://你的域名',
  subscribeTemplateIds: ['你的模板ID']
};
```

域名还得在公众平台的「服务器域名 → request 合法域名」里配好，否则请求会被直接拦掉，页面同样显示读取失败。

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 油价怎么算

调价幅度全国统一，落地零售价按地区定价，所以拆成两层：

```text
某地某油品价格 = 全国价（累加所有调价幅度）+ 地区价差（该地区、该油品）
```

地区价差必须按油品分别存。各省的标号结构并不一致，98# 相对 92# 的地区差从甘肃·兰州的 -0.68 到广东·广州的 +0.89，跨了 1.57 元/升；柴油相对 92# 的差额从海南·海口的 -0.96 到山西·太原的 +0.21。四个油品共用一套价差的话，98# 的误差最大能到 0.89 元/升。

⚠️ 这一层现在是**校验模型**，不是线上算法：线上价格来自采集器抓到的各省发改委公布的最高零售价。这套模型只留在测试夹具里，用来验证地区价差口径 —— 算出来的价格要与各省公布的基准价逐项对得上。

数据真源在 `data/`：

| 文件 | 内容 |
| --- | --- |
| `data/regions.js` | 31 个省级行政区的地区价差与采集页 slug |
| `data/reference-prices.js` | 各省真实挂牌价作校验基准，124 个值逐省比对 |
| `data/adjust-cycle.js` | 调价周期推算（法定节假日表 + 下一轮调价日） |
| `data/ton-conversion.js` | 官方吨价 → 每升折算系数 |
| `data/markets.js` | 国际行情的品种口径（名称 + 报价口径说明） |

`server/src/shared/shared.js` 是 `scripts/sync-shared.js` 生成的产物，不是手写的。改完 `data/` 必须重跑同步脚本，它会断言生成物与 `data/` 逐项一致，手改生成文件，下次同步就给你盖回去。

校验基准里，广东·广州 92# 是 8.91 元/升；自检用这套基准逐省比对 124 个值。

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 后端与接口

自建后端跑在 `server/`，Node 18 + Express + PostgreSQL，部署在自己的服务器上，**后端地址不对外公开**。微信云开发那套已经下线，云函数目录也删了。

前端只认一条链路：

```text
页面 → utils/api.js → utils/cloud.js → 后端
```

取数只有 `utils/api.js` 一个入口，打交道的只有 `utils/cloud.js` 一个文件。换后端只改后者，页面和数据层一行不用动。

### 接口

查询类无需登录：

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/regions` | 无 | `{ regions }` |
| GET | `/api/locate` | `lat, lng` | `{ regionCode, regionName, city, match, distanceKm }` |
| GET | `/api/home` | `regionCode` | `{ region, prices, window, trend30, changes, notice, publishedAt, source }` |
| GET | `/api/trend` | `regionCode, fuelId, period` | `{ region, fuel, price, deltaPercent, direction, axis, points, events, source }` |
| GET | `/api/notices` | `regionCode, filter, fuelId, skip` | `{ region, window, sync, notices, source }` |
| GET | `/api/market` | `symbol, period` | `{ symbol, price, changeAmount, changePercent, direction, open, prevClose, high, low, points, axis, delayed, quoteTime, source }` |
| GET | `/api/sync-status` | 无 | `{ status, sourceName, lastCheckedAt, needsReview, source }` |

用户类要带 `Authorization: Bearer <token>`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `wx.login()` 的 code 换 token |
| GET / POST | `/api/rules` | 读取与保存提醒规则 |
| GET / POST | `/api/history` | 读取与保存提醒历史 |

经纬度换省份走 `/api/locate`。省界数据内置在服务端（`server/src/data/provinces.json`），不依赖第三方逆地理编码服务，也没有配额限制。坐标系统一 GCJ-02，与 `wx.getLocation` 的 `type: 'gcj02'` 对齐。

响应外壳统一：成功是 `{ ok: true, data }`，失败是 `{ ok: false, message, code }`。完整契约见 [`server/openapi.json`](./server/openapi.json)。

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 数据采集

采集器每 30 分钟从**油价网**（[xmgcn.com](https://www.xmgcn.com/)，HTTPS）抓 31 个省级行政区的挂牌价（92#、95#、98#、0#）**和最近 30 期历史**，6 小时新鲜期内不重复抓，31 省 3 并发。一次请求同时拿到现价与整段历史，走势图因此能铺满近一年。

**下次调价预测**由**汽油价格网**（[qiyoujiage.com](http://www.qiyoujiage.com/)，HTTP）提供 —— 这是全网唯一给预测的地方。它还兼两个角色：主源某省抓失败时的现价兜底，以及交叉校核（抽广东/山东/新疆 3 省，现价偏差超过 0.02 元/升就告警）。

两条硬约束一直守着：

1. 解析不出结构化字段就返回空，进人工核对队列，绝不把猜测值发布成正式结果
2. 预测类信息一律标非官方，来源只说方向没给幅度时，幅度留空而不是填 0

历史价入库还有**五道闸门**（价格区间 / 时序去重 / 首尾自洽 / 跨省一致性 / 幂等）。跨省离群值**保留源站原值只告警**，不擅自改写 —— 擅自改才是替来源编数字。

国家发改委调价公告源已启用（列表页 → 详情页两步抓取）；国际行情也已接入真实源（纽约原油与布伦特原油都走东方财富）—— 纽约是 **NYMEX 近月**，布伦特是 **IPE（ICE 布伦特）当月连续**，与新闻里的 ICE 结算价仍有合约基差，国际页把口径写在信息条上。

**来源被拒时不会静默降级**：站点可能用「HTTP 200 + 一张 403 错误页」拒绝访问（2026-11-24 实测油价网如此）。抓取层会认出这种页面并归类为「被拒」，连续被拒 3 次就熔断 6 小时不再敲它；这期间由备源兜底，降级情况会记进采集记录 —— `/api/sync-status` 的 `sources` 字段能逐个看到来源这一轮的状态，`advisories` 是内部源（口径互校之类）的问题，这类问题不点亮用户看到的「等待人工核对」。

口径互校（官方吨价换算成每升，跟各省实测中位数比）的官方吨价改用**发改委公告**——公告本来就在采集、零额外请求，也不会因为某个第三方站点关页面就整个失效。

> [!NOTE]
> 各站 98# 的数据口径本身不统一，和 `data/reference-prices.js` 的个别省份对不上属于口径差异，不是解析 bug。回归测试只对北京、陕西、云南三省做逐值比对。

## 开发脚本

| 命令 | 作用 |
| --- | --- |
| `node scripts/lint-wxml.js` | 静态检查 WXML 绑定、事件、样式类与标签闭合，有错 exit 1 |
| `node scripts/check-modules.js` | 逐个 require 运行时模块与服务端模块，挡加载期 ReferenceError |
| `node scripts/verify-data.js` | 打印数据层算出的价格、走势、通知与国际行情的品种口径 |
| `node scripts/verify-collector.js` | 采集器解析回归，`--live` 追加真实抓取与 pg-mem 入库 |
| `node scripts/verify-chart.js` | 走势图自检：绘图几何、选点算法与组件触摸链路（假的 Canvas 上下文） |
| `node scripts/sync-shared.js` | 由 `data/` 生成服务端共享模块并做一致性断言 |
| `node scripts/build-icons.js` | 重生成 `assets/icons/*.png`，需要本机 Chrome |
| `node scripts/preview-qr.js <appid>` | 上传预览包并出扫码图，必须用正式 AppID |
| `node scripts/verify-in-devtools.js` | 连开发者工具逐页截图并捕获运行时异常 |
| `cd server && npm test` | 后端自检：结构 51 项、HTTP 26 项、文档一致性 60 项，外加调度器与采集器回归 |

静态检查抓出过几个真 bug，比如 `wx:for` 里写成 `{{path}}`（应该是 `{{item.path}}`），以及 `<br>` 不是 WXML 内置标签导致整页编译失败。这类问题静态检查查得出来，渲染结果还得在模拟器里逐页核对。

跑截图脚本前要先装依赖并起自动化服务：

```bash
npm i --prefix .tooling ws
node scripts/verify-in-devtools.js
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 部署

后端走 GitHub Actions：`server/` 有改动推到 `main` 就自动部署，流水线会先跑一遍后端自检，不过不部署。服务器上用 pm2 托管进程，部署过程不碰 nginx，也不碰这台机器上的其他服务。

### 环境变量

真实值只写在服务器的 `server/.env` 里，不入库。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 | 必填 |
| `WX_APP_ID` | 小程序 AppID，与 `project.private.config.json` 同一个 | 必填 |
| `WX_APP_SECRET` | 小程序 AppSecret，只在服务器上 | 必填 |
| `OIL_TOKEN_SECRET` | 自签 token 的密钥，**至少 32 位**的随机字符 | 必填，缺了服务端拒绝启动 |
| `OIL_SUBSCRIBE_TEMPLATE_ID` | 订阅消息模板 ID | 可选，默认取契约表里的主模板 |
| `OIL_SUBSCRIBE_DIRECTION_TEMPLATE_ID` | 方向提醒模板 ID（调整幅度是文本类型的那个） | 可选，不配则每升幅度缺失时不发提醒 |
| `OIL_MINIPROGRAM_STATE` | 订阅消息跳转的版本：`formal` / `developer` / `trial` | `formal` |
| `OIL_API_BASE_URL` | 后端对外地址，流水线用它做健康检查 | 无 |
| `PORT` | 服务端口 | `3000` |
| `OIL_COLLECT_CRON` | 采集频率，六段 cron | `0 */30 * * * *` |
| `OIL_ALERT_CRON` | 提醒频率，六段 cron | `0 */10 * * * *` |

建表结构在 [`server/schema.sql`](./server/schema.sql)，环境变量样例在 [`server/.env.example`](./server/.env.example)，流水线每一步在 [`.github/workflows/deploy-backend.yml`](./.github/workflows/deploy-backend.yml)。

### 订阅消息模板

模板在微信公众平台「订阅消息 → 我的模板」里申请。拿到**模板 ID**和**占位符名**（模板详情页上能看到，形如 `thing5`、`amount2`）之后，三处要同步：

| 位置 | 放什么 |
| --- | --- |
| `server/src/services/subscribe-templates.js` | 模板契约：字段名、类型、角色。这是唯一真源 |
| `server/.env`（服务器上） | `OIL_SUBSCRIBE_TEMPLATE_ID`：实际用的模板 ID |
| `config/index.js`（小程序端） | `subscribeTemplateIds`：要向用户申请授权的模板 ID |

契约表里每个字段都带一个**角色**（`fuel` / `amount` / `direction` / `date` / `price` / `tip`），业务代码只给语义值，字段名由契约表按角色填 —— 换个模板占位符名变了，也不用改业务代码。

**当前在用的模板**（编号 1103「油价调整提醒」，模板 ID `OaHgjTXIhVAUOtdvqE_yxVbqLaHLbFN5MJS3lNFQVt0`）一共 5 个字段：

| 占位符 | 类型 | 角色 | 装什么 |
| --- | --- | --- | --- |
| `thing5` | 文本（≤20 字符） | `fuel` | 油品种类。**没有「温馨提示」字段时，地区与口径说明也挤在这一行** |
| `phrase1` | 短语（≤5 汉字） | `direction` | 调整方向（下调 / 已达目标 / 预计下调） |
| `amount2` | 数字 | `amount` | 调整价格 —— 这里放的是**每升调整幅度**（「0.52元」），不是调完之后的价 |
| `amount6` | 数字 | `price` | 实时油价（当前挂牌价） |
| `date3` | 日期 | `date` | 调整日期 |

⚠️ 这个模板的第 6 个关键词换成了「实时油价」，**「温馨提示」没了** —— 地区与口径说明（实测 / 测算 / 非官方）没有专门字段可放，只能并进「油品种类」那一行（≤20 字符）。装不下时按重要性取舍：现价 → 地区 → 额外说明 → 幅度整句，**口径说明必留**（测算值、预测值不标口径就是误导），被丢弃的内容会在服务端日志里留一条警告。

**怎么挑字段**：一条提醒要装下这些信息 —— 油品、调整方向、调整幅度、调整日期、当前油价、口径说明。平台上的常用关键词只覆盖前几项，所以：

- **有「实时油价」这类字段**（当前模板就有）→ 现价有自己的位置，不用挤进别的字段；
- **有「温馨提示」字段** → 地区与口径写进提示，「油品种类」只留油品名；
- **两个都没有** → 地区与口径并进「油品种类」，20 字要塞下「油品·地区·口径」，很紧；
- **「调整价格」是数字型**（占位符 `amount2`）→ 只能填「0.52元」，装不下「幅度待公布」；
  是文本型（`thing2`）→ 能写「每升下调0.52元」「幅度待公布」这种整句。

关键词不够用时，在公众平台「添加模板」页点「点击申请」新增即可：关键词名「实时油价」，数据类型选**数字**（要放「8.39元」这种数值），枚举值留空。

**方向模板**：发改委公告只给吨价，每升幅度要等各地新挂牌价采到才有值。主模板的「调整价格」是 `amount` 类型，只能填「数字+元」—— 填 `0` 是冒充「持平」，填吨价是把两个口径混在一起。这种时候需要一个**「调整幅度」是文本类型**的模板，由它把「幅度待公布」原样发出去：

- 契约表里给它加一条登记，其中 `amount` 角色的字段类型不能是 `amount`；
- 服务器 `.env` 填 `OIL_SUBSCRIBE_DIRECTION_TEMPLATE_ID`；
- 小程序端 `config/index.js` 填 `subscribeDirectionTemplateId` —— 用户得授权它，一次性额度是按模板给的。

两处不配也能跑：那轮「每升幅度还没拿到」的官方降价提醒就发不出去，服务端会在运行汇总里记一条 `NO_LITER_AMOUNT`，运维看得见原因，不会安静地什么都不发。

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 发版到微信平台

小程序包用微信官方的 [miniprogram-ci](https://github.com/wechat-miniprogram/miniprogram-ci) 上传，不依赖开发者工具 —— 开发者工具的 CLI 要求 IDE 开着、已登录，CI 上跑不了。

触发方式（[`.github/workflows/release-miniprogram.yml`](./.github/workflows/release-miniprogram.yml)）：

| 触发 | 说明 |
| --- | --- |
| 推 tag `v*` | `git tag v0.2.0 && git push origin v0.2.0` → 自动上传 |
| 发 GitHub Release | 同样会触发上传 |
| 手动触发 | Actions 页面点「Run workflow」，可手填版本号与描述 |

版本号默认从 git tag 取（`v0.2.0` → `0.2.0`）；手动触发时可留空。上传前流水线会先跑一遍前端自检（WXML 静态检查、模块加载、数据层、走势图），不通过就不会上传。

### ⚠️ 自动化到哪一步

| 步骤 | 谁来做 |
| --- | --- |
| 打包 + 上传代码（开发版本） | ✅ 流水线自动 |
| 提交审核 | ❌ 人工：公众平台 → 版本管理 → 开发版本 → 提交审核 |
| 发布 | ❌ 人工：审核通过后点发布 |

`miniprogram-ci` 没有提交审核接口。微信的 `wxa/commit`（提交审核）与 `wxa/release`（发布）只对**第三方平台**开放，个人主体小程序拿不到这两个 API，只能去后台点。

### 提交审核时的版本描述

公众平台「版本管理 → 开发版本 → 提交审核」那张表里，**版本描述**是唯一每次都要写的那项。草稿用脚本生成：

```bash
node scripts/release-desc.js --version 1.0.2
```

草稿是提交标题拼的，**提交前改成用户视角的一句话** —— 审核员和用户看的是这句，不是 commit 标题。发版的流水线会自动把草稿写进运行 summary。

### 必配项

1. 公众平台 → 开发管理 → 开发设置 → **小程序代码上传** → 生成上传密钥，下载 `private.key`。
   ⚠️ 同一页的 **IP 白名单要留空** —— GitHub runner 的出口 IP 不固定，填了就传不上去，平台会回 `errCode -10008 invalid ip: <runner 的出口 IP>`。
2. 仓库加两个 secret（Settings → Secrets and variables → Actions）：

   | 名称 | 内容 |
   | --- | --- |
   | `WX_APP_ID` | 正式 AppID，与 `project.private.config.json` 里是同一个 |
   | `WX_UPLOAD_PRIVATE_KEY` | `private.key` 的全部内容（含 `-----BEGIN PRIVATE KEY-----` 头尾） |

   AppID 只出现在仓库 secret 与本地私有配置里，`project.config.json` 存的是占位 `touristappid`。
3. 首次发版前先本地试一次，确认密钥与 AppID 对得上：

```bash
npm ci --prefix ci
WX_APP_ID=wx... WX_UPLOAD_PRIVATE_KEY_PATH=./private.key node ci/upload.js --dry-run
```

本地真上传：`node ci/upload.js`（AppID 默认读 `project.private.config.json`，密钥用 `WX_UPLOAD_PRIVATE_KEY_PATH` 指文件或 `WX_UPLOAD_PRIVATE_KEY` 传内容）。

打包要排除的目录统一写在 `project.config.json` 的 `packOptions.ignore`（`ci/`、`server/`、`scripts/`、`docs/` 等）—— **别在上传脚本里另写一份清单**，两份对不上就会把源码和服务端代码一起传上去。

<p align="right">(<a href="#readme-top">back to top</a></p>

## 已知限制

- 订阅消息已换成带「实时油价」的新模板（模板 ID `OaHgjTXIhVAUOtdvqE_yxVbqLaHLbFN5MJS3lNFQVt0`，5 个字段，**没有「温馨提示」字段** —— 地区与口径说明并进「油品种类」那一行）。线上还要改服务端 `.env` 的 `OIL_SUBSCRIBE_TEMPLATE_ID`；换模板后用户必须在提醒页**重新授权**（一次性额度按模板给，旧模板的额度不会挪过去）；微信的订阅消息是**一次性**授权，用户每次同意只够收一条，用完要重新授权
- 国际行情用的是东方财富的公开接口，**不是官方授权数据**，只作市场趋势参考；布伦特是 IPE 当月连续合约，与 ICE 布伦特期货结算价仍有合约基差；两个品种的曲线都来自公开 K 线接口（5 分钟线 + 日线），休市时点数不涨是事实不是 bug
- 现价与历史走 **HTTPS 的油价网**；**汽油价格网没有 HTTPS**（证书是 CDN 通用证书，不含该域名），只有「下次调价预测」走明文 HTTP —— 抓取层已做重定向白名单、总时限与价格交叉校验，但明文链路本身的风险消不掉
- 服务端启动前会强校验 `OIL_TOKEN_SECRET`（≥32 位）与 `DATABASE_URL`，缺一直接拒绝启动；健康检查分两个：`/health` 只说明进程活着，`/ready` 才真的连库
- 后端不可用时小程序不显示任何数据：页面显示失败态与重试按钮，**不再回落演示数据**（演示数据已全部删除）
- 页面 WXSS 里还有 42 处硬编码色值（26 处 hex + 16 处 rgba 阴影/边框）没走 `styles/tokens.wxss` 的设计令牌，纯样式一致性问题，不影响功能
- 小程序主包有 2MB 上限，`project.config.json` 的 `packOptions.ignore` 已经排除了 `docs`、`design`、`scripts`、`server`、`.github` 这些非运行文件
- 换过 AppID 之后预览二维码要重出，预览包是按 AppID 上传的，旧码会指向已经不存在的账号

## License

MIT，见 [LICENSE](./LICENSE)。

## 参考资料

- [采集源解析实现](./server/src/services/sources.js)：每个来源怎么解析、怎么验证
- [接口契约](./server/openapi.json)：接口清单与响应结构
- [数据库结构](./server/schema.sql)：建表、索引与老库补列语句
- [部署流水线](./.github/workflows/deploy-backend.yml)：GitHub Actions 的每一步
- [订阅消息模板契约](./server/src/services/subscribe-templates.js)：字段名与取值格式的唯一真源
- [已知坑](./AGENTS.md)：小程序与后端踩过并记下来的陷阱
- [产品与页面设计](./design/product-design.md)：设计真源
- [油价网](https://www.xmgcn.com/)：现价与历史的主源
- [汽油价格网](http://www.qiyoujiage.com/)：下次调价预测的来源，兼兜底与交叉校核
- [国家发改委](https://www.ndrc.gov.cn/)：正式调价公告
- [aalavender/OilPrice](https://github.com/aalavender/OilPrice) 与 [vikiboss/60s](https://github.com/vikiboss/60s)：采集写法参考
- [微信订阅消息文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)

<!-- MARKDOWN LINKS & IMAGES -->
[version-shield]: https://img.shields.io/github/v/tag/uwakeme/oil-trend.svg?style=for-the-badge
[version-url]: https://github.com/uwakeme/oil-trend/tags
[license-shield]: https://img.shields.io/github/license/uwakeme/oil-trend.svg?style=for-the-badge
[license-url]: https://github.com/uwakeme/oil-trend/blob/main/LICENSE
[stars-shield]: https://img.shields.io/github/stars/uwakeme/oil-trend.svg?style=for-the-badge
[stars-url]: https://github.com/uwakeme/oil-trend/stargazers
[forks-shield]: https://img.shields.io/github/forks/uwakeme/oil-trend.svg?style=for-the-badge
[forks-url]: https://github.com/uwakeme/oil-trend/network/members
[issues-shield]: https://img.shields.io/github/issues/uwakeme/oil-trend.svg?style=for-the-badge
[issues-url]: https://github.com/uwakeme/oil-trend/issues
[backend-shield]: https://img.shields.io/badge/backend-online-brightgreen?style=for-the-badge
[backend-url]: https://github.com/uwakeme/oil-trend/tree/main/server
