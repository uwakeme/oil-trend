# 自建后端方案

> **状态：已完成。** 后端跑在自建服务器上（Node + Express + PostgreSQL），
> 微信云开发那套已下线、云函数目录已删（见 git 历史）。
> 这份文档保留下来当契约与设计说明 —— 下面提到的「云函数」都是迁移前的对照。

最初是从微信云开发迁到自己的服务器，本文固定契约与流程。

## 一、为什么能换

前端只认三层，边界很清楚：

```
页面 → utils/api.js → utils/cloud.js → 后端
```

- `utils/api.js` 是唯一取数入口，已经做到「云端优先 + 本地兜底」，
  并给每个返回值打上来源标记（`stampSource`）
- `utils/cloud.js` 是唯一跟后端打交道的文件，只有它知道用的是 HTTP 还是走本地演示数据
- 五个页面、`data/` 下的数据层、`utils/format.js` 全都不感知后端形态

所以后端换了，前端要动的只有 `utils/cloud.js` 一个文件。

## 二、接口契约（必须一比一复刻）

服务端要实现下面这些接口，返回结构与页面既有的期望**完全一致**。
前端 `utils/api.js` 的 `hasExpected` 会检查返回里有没有必需字段，
结构对不上就会静默回落到演示数据 —— 页面看着正常，实际没走服务端。

### 查询类（无需登录）

| 路径 | 入参 | 返回 | 页面用在 |
| --- | --- | --- | --- |
| `GET /api/regions` | — | `{ regions: [{ code, name, city, fullName, price92 }] }` | 地区选择弹层 |
| `GET /api/home` | `regionCode` | `{ prices[], window, trend30, changes, notice, publishedAt, source }` | 首页 |
| `GET /api/trend` | `regionCode, fuelId, period` | `{ points[], labels[], events[], period }` | 走势页 |
| `GET /api/notices` | `regionCode, filter, fuelId, skip` | `{ notices[], total }` | 调价页 |
| `GET /api/market` | `symbol, period` | `{ price, changeAmount, changePercent, direction, open, prevClose, high, low, points[], labels[], delayed, quoteTime }` | 国际页 |
| `GET /api/sync-status` | — | `{ status, sourceName, startedAt, finishedAt, needsReview[] }` | 调价页顶部状态行 |

### 用户类（需要登录态）

| 路径 | 入参 | 返回 |
| --- | --- | --- |
| `POST /api/login` | `{ code }` | `{ token, openid }` |
| `GET /api/rules` | — | `{ rules[] }` |
| `POST /api/rules` | `{ rules[] }` | `{ rules[] }` |
| `GET /api/history` | — | `{ history[] }` |
| `POST /api/history` | `{ history[] }` | `{ history[] }` |

### 统一响应外壳

统一外壳是 `{ ok: true, data: {...} }` 或 `{ ok: false, message, code }`。
服务端**沿用同一个外壳**：

```js
{ ok: true,  data: { ... } }
{ ok: false, message: '...', code: '...' }
```

前端 `utils/cloud.js` 已经在按这个约定解析，`ok === false` 会 reject 并回落。

### 现有 action 与新路径的对应

| 早期云函数 action | 新路径 |
| --- | --- |
| `regions` | `GET /api/regions` |
| `home` | `GET /api/home` |
| `trend` | `GET /api/trend` |
| `notices` | `GET /api/notices` |
| `market` | `GET /api/market` |
| `rules.list` | `GET /api/rules` |
| `rules.save` | `POST /api/rules` |
| `history.list` | `GET /api/history` |
| `history.save` | `POST /api/history` |
| `openid` | `POST /api/login`（返回值语义不同：前端要的是登录态而不是 openid 本身） |

「同步状态」早期是 `actionHome` 里顺带返回的。
拆成独立接口是因为它只被调价页用，不必混进首页响应。

## 三、认证流程（云开发没有，自建必须补）

云开发里 `cloud.getWXContext()` 直接给 openid。自建没有这个能力，
要自己走一遍：

```
小程序 wx.login() → 拿到 code（5 分钟有效、一次性）
    ↓ POST /api/login { code }
服务端 code2session(code + appid + secret) → { openid, session_key }
    ↓
服务端签发自己的 token（HMAC 签名，含 openid + 过期时间）
    ↓
后续请求带 Authorization: Bearer <token>
```

要点：

- **AppSecret 只在服务端**，走环境变量，不进代码、不进小程序包
- `session_key` 不用保存，但 `code2session` 的 code 是一次性的，不能重放
- token 自己签发：`base64(payload).base64(hmac(payload))`，payload 里放 openid 和过期时间
  —— 不引入额外依赖，也不用 session 存储
- 前端要改：`app.js` 启动时 `wx.login()` 换 token，存本地；
  token 过期（服务端返回 401）就重新登录一次

### 订阅消息下发

自建后端走微信官方 HTTP 接口，不依赖云开发：

```
POST https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=XXX
{ touser: openid, template_id, page, data: { thing1: {...}, ... } }
```

- access_token 用 appid + secret 换，有效期 2 小时，**必须缓存并提前刷新**
  （多个实例各自缓存一份也没问题，微信对同一 appid 的 token 刷新有容忍度）
- 模板字段名必须与公众平台申请时的一字不差，映射表在 `oilAlert` 的 `TEMPLATE_FIELDS`

## 四、数据层

云数据库是文档模型，自建换成关系库。集合与表对应：

| 集合 | 表 | 说明 |
| --- | --- | --- |
| `oil_prices` | `oil_prices` | 当前价，唯一键 (region_code, fuel_id) |
| `oil_price_history` | `oil_price_history` | 历史价，唯一键 (region_code, fuel_id, date) |
| `oil_adjust_events` | `oil_adjust_events` | 调价节点 |
| `oil_notices` | `oil_notices` | 调价通知，dedup_key 唯一 |
| `oil_windows` | `oil_windows` | 下一轮调价窗口 |
| `oil_markets` | `oil_markets` | 国际行情 |
| `alert_rules` | `alert_rules` | 提醒规则，按 user_id |
| `alert_logs` | `alert_logs` | 提醒记录，dedup_key 唯一 |
| `oil_users` | `oil_users` | 用户标识，openid 唯一 |
| `collector_runs` | `collector_runs` | 采集运行记录 |

字段命名：业务层用 camelCase，库里用 snake_case，映射集中在 DAO 层做，
不把命名转换散落在业务代码里。

⚠️ `DATE` 列要转成 `YYYY-MM-DD` 字符串，且必须按**本地**日历日取：
node-postgres 把 DATE 解析成「本地零点」的 Date，用 `toISOString()` 取日期
在 UTC+8 会整体退一天（线上真踩过，窗口日期显示成昨天）。

⚠️ 新增列用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 写在 schema.sql 末尾，
部署脚本每次都跑这个文件，老库能自动补列。`forecast_direction` 就是这么加的。

### 共享算法不能重写

`data/` 下的调价时间线（24 条）、地区价差、油品定义、行情生成是**纯 JS**，
现在靠 `scripts/sync-shared.js` 从 `data/` 生成到 `server/src/shared/` 并加一致性断言。

服务端也要用同一份 —— 同步脚本把 `data/` 生成到 `server/src/shared/shared.js`，
断言逻辑照抄。这样两端数值必然一致，不需要重新实现价格模型。

## 五、定时任务

云开发用触发器，自建用 crontab 或进程内调度：

| 任务 | 频率 | 入口 |
| --- | --- | --- |
| 采集 | 每 30 分钟 | `collector.run()` |
| 提醒匹配 | 每 10 分钟 | `alert.run()` |

用进程内调度（`server/src/scheduler.js`，自己实现的 6 段 cron，没引 node-cron）
比 crontab 好：不用关心部署环境的 crontab 配置，日志也在同一个进程里。

⚠️ cron 字段必须支持星号步长（`*` + `/N` 那种写法）—— 第一版只认纯数字，
默认配置直接解析成 `null`，采集器和提醒器在线上一次都没跑过。
现在由 `server/scripts/scheduler-test.js` 钉住。

多实例部署时同一时刻会各跑一次：采集器靠 dedupKey 去重，提醒器靠
alert_logs 的 dedupKey，所以即使重复跑也不会发重复消息，但会浪费配额。

## 六、目录结构

```
server/
├── package.json
├── .env.example              # 环境变量样例（AppSecret 等）
├── src/
│   ├── index.js              # 入口，起 HTTP 服务
│   ├── config.js             # 读环境变量
│   ├── app.js                # Express 应用与路由装配
│   ├── routes/
│   │   ├── api.js            # 业务路由
│   │   └── auth.js           # 登录路由
│   ├── middleware/
│   │   └── auth.js           # token 校验
│   ├── dao/
│   │   ├── prices.js
│   │   ├── history.js
│   │   ├── notices.js
│   │   ├── markets.js
│   │   ├── windows.js
│   │   ├── rules.js
│   │   ├── logs.js
│   │   ├── users.js
│   │   └── runs.js
│   ├── services/
│   │   ├── auth.js           # code2session + token 签发校验
│   │   ├── subscribe.js      # 订阅消息下发 + access_token 缓存
│   │   ├── collector.js      # 采集流程
│   │   ├── alert.js          # 提醒匹配
│   │   └── home.js           # 首页聚合
│   └── shared/               # 由 sync-shared.js 生成，勿手改
│       └── shared.js
└── scripts/
    ├── test-fixtures.js      # 测试夹具：灌演示数据到内存库
    ├── selftest.js           # 结构自检
    ├── http-test.js          # HTTP 层自检
    └── check-openapi.js      # 文档与实现一致性检查
```

## 七、迁移步骤

1. 建库建表 + 索引
2. `scripts/sync-shared.js` 生成到 `server/src/shared/`
3. 实现 DAO 层
4. 实现 services
5. 实现 routes
6. 起服务，本地 curl 验接口
7. 改 `utils/cloud.js`：走 HTTP
8. 改 `app.js`：加 `wx.login` 换 token
9. 真机联调：配 request 合法域名
10. 验证链路：跑 `cd server && npm test`（测试跑在内存库上，不碰真实库）
11. 云函数已下线并删除（见 git 历史）

第 7 步之前，小程序端一行都不用改 —— 所以可以先在服务端把接口全部验通，
再切前端。这是这个方案最舒服的地方。

## 八、风险与前置条件

| 事项 | 说明 |
| --- | --- |
| **已备案域名** | 小程序 request 合法域名必须是 HTTPS + 已备案域名，没有则真机联调做不了 |
| **HTTPS 证书** | 自签证书不行，要能被微信信任的 CA 证书 |
| **AppSecret 安全** | 放环境变量，服务器权限收紧，不进代码库 |
| **access_token 缓存** | 2 小时有效，多实例各自缓存；要处理刷新失败重试 |
| **微信接口可达性** | 服务器要能稳定访问 `api.weixin.qq.com`，境内节点更稳 |
| **回滚** | 云函数已删除；回滚靠自建服务的 PM2 与 git 历史 |
| **数据迁移** | 云数据库里现有的演示数据不必搬迁，自建后端不灌演示数据 |
