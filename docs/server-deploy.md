# 自建后端部署

把油势的后端从微信云开发搬到自己的服务器。设计与契约见
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
| `WX_APP_ID` | 小程序 AppID（与 `project.private.config.json` 同一个） |
| `WX_APP_SECRET` | 小程序 AppSecret，**只在服务器上** |
| `OIL_SUBSCRIBE_TEMPLATE_ID` | 订阅消息模板 ID |
| `OIL_TOKEN_SECRET` | 自签 token 的密钥，随便一串长随机字符 |
| `OIL_COLLECT_CRON` | 采集频率，默认 `0 */30 * * * *` |
| `OIL_ALERT_CRON` | 提醒频率，默认 `0 */10 * * * *` |

## 四、数据从哪来

**生产库不灌演示数据。** 部署流水线不会自动 seed ——
之前「库空就自动灌」的逻辑会导致每次部署都把演示数据灌回去，
手动清理完下一次部署又白清。

数据来源只有两条：

1. **真实采集**：`server/src/services/sources.js` 里启用采集源后，
   采集器按 `OIL_COLLECT_CRON` 的频率写库
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
  // 后端地址：自建服务器。留空则回落到微信云开发。
  apiBaseUrl: 'https://你的域名',
  subscribeTemplateIds: ['你的模板ID'],
  dataSource: 'auto'
}
```

小程序端只有这一个文件要知道后端地址。`utils/cloud.js` 会自动走
HTTP，不再调用云函数。

## 七、配置小程序合法域名

公众平台 →「开发管理」→「开发设置」→「服务器域名」→ request 合法域名，
加上你的域名（要带 https://）。

**这一步不做，小程序端请求会被直接拦掉。**

## 八、订阅消息联调

1. 公众平台申请订阅消息模板，把模板 ID 填进
   `config/index.js` 的 `subscribeTemplateIds` 和服务端 `.env` 的
   `OIL_SUBSCRIBE_TEMPLATE_ID`（两处同值）。
2. 模板字段名要和 `server/src/services/alert.js` 的 `TEMPLATE_FIELDS`
   一字不差。当前默认是 `thing1` / `thing2` / `amount3` / `time4`。
3. 开发版/体验版联调时，服务端 `.env` 加：
   ```
   OIL_MINIPROGRAM_STATE=developer
   ```
   正式发布留空（默认 `formal`）。

## 九、验证清单

| 检查 | 怎么验 |
| --- | --- |
| 服务活着 | `curl /health` 返回 `{"ok":true,...}` |
| 接口通 | `curl /api/regions` 返回 10 个地区 |
| 数据对 | `curl /api/home?regionCode=440000` 的价格与小程序演示源一致 |
| 登录通 | 小程序「提醒」页保存规则后刷新，规则还在（说明 token 生效） |
| 采集跑 | 服务端日志有「[collector] 运行」；`collector_runs` 表有记录 |
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

云函数**先别删**。前端把 `config/index.js` 的 `apiBaseUrl` 清空就
切回云开发，出问题能立刻回退。云函数确认不再用之后再清理。

## 十二、安全清单

- [ ] `.env` 不在版本库里（`.gitignore` 已加 `server/.env`）
- [ ] AppSecret 只在服务器环境变量里
- [ ] 数据库只监听内网 / 用安全组限制来源
- [ ] 服务器装了自动安全更新
- [ ] `OIL_TOKEN_SECRET` 换过随机值，没用默认值