# 自建后端部署

油价势的后端部署在同一台服务器上（Node + Express + PostgreSQL）。设计与契约见
[self-hosted-backend.md](self-hosted-backend.md)。

## 一、准备

1. **服务器**：一台能跑 Node 18+ 的云服务器（轻量应用服务器即可）。
2. **PostgreSQL 15+**：本机装或用云数据库。
3. **已备案域名 + HTTPS 证书**：小程序 request 合法域名必须是
   HTTPS + 已备案域名，没有就联调不了。

## 二、装依赖与建表

```bash
cd server
npm install --omit=dev
```

建表（连到目标库执行）：

```bash
psql "$DATABASE_URL" -f schema.sql
```

`schema.sql` 里全是 `CREATE TABLE IF NOT EXISTS`，重复执行安全。

## 三、配置环境变量

```bash
cp .env.example .env
```

然后填真实值。**`.env` 不入库**（已在 .gitignore 里）。

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `PORT` | 服务端口，默认 3000；线上用 3002（避开同机的 lyric_lab） |
| `WX_APP_ID` | 小程序 AppID（与 `project.private.config.json` 同一个） |
| `WX_APP_SECRET` | 小程序 AppSecret，**只在服务器上** |
| `OIL_SUBSCRIBE_TEMPLATE_ID` | 订阅消息模板 ID，默认用 `server/src/services/subscribe-templates.js` 里的主模板 |
| `OIL_MINIPROGRAM_STATE` | 订阅消息跳转的小程序版本：`formal` 正式版（默认）/ `developer` 开发版 / `trial` 体验版 |
| `OIL_TOKEN_SECRET` | 自签 token 的密钥，随便一串长随机字符 |
| `OIL_API_BASE_URL` | 后端对外地址，部署流水线拿它做健康检查 |
| `OIL_COLLECT_CRON` | 采集频率，默认 `0 */30 * * * *`（6 段：秒 分 时 日 月 周） |
| `OIL_ALERT_CRON` | 提醒频率，默认 `0 */10 * * * *` |

## 四、数据从哪来

**生产库不灌演示数据。** 部署流水线不会自动 seed ——
之前「库空就自动灌」的逻辑会导致每次部署都把演示数据灌回去，
手动清理完下一次部署又白清。

数据来源只有两条：

1. **真实采集**：`server/src/services/sources.js` 里汽油价格网（qiyoujiage）
   默认启用，采集器按 `OIL_COLLECT_CRON` 的频率抓 31 个省页写库；
   ndrc 公告与国际行情两个源仍默认关闭
2. **人工录入**：直接往库里写（正式公告需要人工复核时走这条路）

演示数据只存在于测试里：`server/scripts/test-fixtures.js`，
测试跑在内存库（pg-mem）上，不会碰真实数据库。

## 五、起服务

```bash
cd server
npm start
```

或者用 systemd / pm2 托管。健康检查：

```bash
curl https://你的域名/health
```

## 六、切前端

改 `config/index.js`：

```js
module.exports = {
  // 后端地址：自建服务器。留空则一律使用本地演示数据。
  apiBaseUrl: 'https://你的域名',
  subscribeTemplateIds: ['你的模板ID'],
  dataSource: 'auto'
}
```

小程序端只有这一个文件要知道后端地址。`utils/cloud.js` 会自动走
HTTP。

## 七、配置小程序合法域名

公众平台 →「开发管理」→「开发设置」→「服务器域名」→ request 合法域名，
加上你的域名（要带 https://）。

**这一步不做，小程序端请求会被直接拦掉。**

## 八、订阅消息联调

### 模板在哪、字段怎么填

平台模板的**镜像**是 `server/src/services/subscribe-templates.js`，
字段名和取值格式的唯一真源就在那里。当前用的是
「油价调整提醒」（编号 1103，信息查询），5 个字段：

| 字段 | 占位符 | 类型 | 约束 | 提醒里填什么 |
| --- | --- | --- | --- | --- |
| 油品种类 | `thing5` | thing | ≤20 字符 | `92# 汽油` |
| 调整价格 | `amount2` | amount | ≤10 字符，`"0.13元"` | 降价幅度 / 目标价 |
| 调整方向 | `phrase1` | phrase | ≤5 字符 | 下调 / 预计下调 / 已达目标 |
| 调整日期 | `date3` | date | `"2026年11月24日"` | 执行日 / 命中当天 |
| 温馨提示 | `thing4` | thing | ≤20 字符 | 地区与当前价 |

模板里**没有**「地区」「当前价」「目标价」字段，
所以地区和当前价只能塞进「温馨提示」。

### 三处要同步

换模板时这三处必须一起改，改漏了消息发不出去：

1. `server/src/services/subscribe-templates.js` —— 字段契约与主模板 ID
2. `config/index.js` 的 `subscribeTemplateIds` —— 小程序端发起授权用的 ID
3. 服务端 `.env` 的 `OIL_SUBSCRIBE_TEMPLATE_ID` —— 服务端下发用的 ID

服务端 `.env` 没配时会退回契约表里的主模板；
配了一个**没登记在契约表里**的 ID，服务端会拒绝下发并在日志里写
`TEMPLATE_NOT_REGISTERED`，不会拿猜的字段去撞平台。

### 一次性授权

微信的订阅消息是**一次性**的：用户每次点同意只够发一条。
所以：

- 命中多条提醒时只发第一条；
- 发成功后服务端把这条规则的订阅额度置回「未授权」，并记下用掉时间；
- 提醒页会显示「授权已用完」，用户重新授权才能再收。

界面上不能一直显示「微信提醒已开启」——微信那边其实已经拒收了。

### 开发版联调

开发版/体验版联调时，服务端 `.env` 加：
```
OIL_MINIPROGRAM_STATE=developer
```
正式发布留空（默认 `formal`）。

## 九、验证清单

| 检查 | 怎么验 |
| --- | --- |
| 服务活着 | `curl /health` 返回 `{"ok":true,...}` |
| 接口通 | `curl /api/regions` 返回 31 个地区 |
| 数据对 | `curl /api/home?regionCode=440000` 的 92# 落在 8.6–10.1 元/升（各省挂牌价区间），`source.mode` 是 `server` |
| 登录通 | 小程序「提醒」页保存规则后刷新，规则还在（说明 token 生效） |
| 采集跑 | `collector_runs` 每 30 分钟多一条 `ok`；`oil_prices` 共 124 行（31 省 × 4 油品） |
| 提醒能发 | 造一条已复核的降价通知，等一个 `OIL_ALERT_CRON` 周期，看 `alert_logs` 里 `sent` 为 true |

## 十、出问题先看这里

| 现象 | 多半是 |
| --- | --- |
| 小程序一直显示「演示数据」 | 域名没配进 request 合法域名，或 `apiBaseUrl` 没填 |
| 规则保存后没了 | token 没拿到（`wx.login` 失败）或服务端 401 |
| 提醒不下发 | `subscribeGranted` 为 false，或模板字段名对不上 |
| 服务起不来 | `.env` 缺 `DATABASE_URL` |
| 采集一直 idle | 采集源默认全关（`server/src/services/sources.js` 里 `enabled: false`） |
| 多实例重复跑 | 目前靠 dedupKey 去重，用户量上来要加分布式锁 |

## 十一、回滚

后端出问题要临时顶住：把 `config/index.js` 的 `apiBaseUrl` 清空，
小程序会回落到本地演示数据（页面标「演示数据」），不会白屏。
服务端本身回滚用 `git revert` 后重跑部署流水线。

## 十二、安全清单

- [ ] `.env` 不在版本库里（`.gitignore` 已加 `server/.env`）
- [ ] AppSecret 只在服务器环境变量里
- [ ] 数据库只监听内网 / 用安全组限制来源
- [ ] 服务器装了自动安全更新
- [ ] `OIL_TOKEN_SECRET` 换过随机值，没用默认值