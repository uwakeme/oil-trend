# Apifox 接口文档

后端接口的 OpenAPI 3.0 文件：`server/openapi.json`

## 一、导入 Apifox

1. 打开 Apifox →「项目设置」→「导入数据」→「OpenAPI/Swagger」
2. 选择 `server/openapi.json`
3. 格式选 **OpenAPI 3.0**，导入模式选 **URL 导入** 或 **文件导入**（都行）
4. 导入后得到一个「油价势 · 后端 API」项目，12 个接口、24 个数据模型

## 二、导入后要改的

| 项 | 说明 |
| --- | --- |
| 服务地址 | `http://127.0.0.1:3002` 换成你的域名。生产环境用 `https://api.你的域名` |
| 环境变量 | 建议建两个环境：`local` 指向本机，`prod` 指向线上 |

## 三、鉴权配置

用户类接口（`/api/rules`、`/api/history`）需要 token。

在 Apifox 里配一个 **Bearer Token** 前置操作，全局自动带上：

1. 「项目设置」→「前置操作」→「前置操作」→ 新建
2. 类型选 **前置操作 → 设置请求头**
3. 头名 `Authorization`，值 `Bearer {{token}}`
4. 再加一条**后置操作**，从登录响应里取 token 存到变量：

```js
// Apifox 后置操作脚本
const body = pm.response.json();
if (body && body.ok && body.data && body.data.token) {
  pm.environment.set('token', body.data.token);
}
```

这样先跑一次「登录」接口，后面的接口就自动带上了。

## 四、测试用例已经内置

OpenAPI 文件里带了不少 example：

- 每个接口的成功响应示例
- 登录失败、401 的错误示例
- 各字段的真实取值（不是编的，是从实际接口跑出来的）

在 Apifox 里点「发送」就能看到填好的示例值。

## 五、文档为什么可信

`server/scripts/check-openapi.js` 会**真起服务、真发请求**，
把实际返回的字段跟文档声明逐个比对：

```bash
cd server && npm test
```

覆盖 60 项检查：

- 路由里有的接口，文档里必须声明（漏写会被抓出来）
- 文档里声明的接口，路由里必须真实存在（写错了会被抓出来）
- 每个接口的实际返回字段，必须与 schema 一致
- 401 响应码、错误码、枚举值必须与文档一致
- 关键字段类型必须对（`fuelId` 是字符串不是数字、日期是 `YYYY-MM-DD`）

**改了接口但忘了改文档，或者改了文档但忘了改接口，测试会直接失败。**

## 六、接口速查

| 方法 | 路径 | 说明 | 需登录 |
| --- | --- | --- | --- |
| GET | `/health` | 健康检查 | 否 |
| POST | `/api/login` | code 换 token | 否 |
| GET | `/api/regions` | 地区列表（含 92# 现价） | 否 |
| GET | `/api/home` | 首页：现价 / 窗口 / 30 天走势 / 最新通知 | 否 |
| GET | `/api/trend` | 走势：阶梯线 + 调价节点 | 否 |
| GET | `/api/notices` | 调价通知列表（只含已复核） | 否 |
| GET | `/api/market` | 国际行情 Brent / WTI | 否 |
| GET | `/api/sync-status` | 采集同步状态 | 否 |
| GET | `/api/rules` | 读提醒规则 | **是** |
| POST | `/api/rules` | 存提醒规则 | **是** |
| GET | `/api/history` | 读提醒记录 | **是** |
| POST | `/api/history` | 存提醒记录 | **是** |

## 七、几个容易踩的点

- **统一外壳**：所有接口返回 `{ok, data}` 或 `{ok:false, message, code}`。
  `ok:false` 时 HTTP 状态码**仍是 200**，只有鉴权失败才 401。
- **`fuelId` 是字符串**：`"92"` 不是 `92`。转成数字前端判断会全失效。
- **日期是 `YYYY-MM-DD` 字符串**，不是时间戳。时间戳字段是 `publishedAt` / `updatedAt` / `time`。
- **`market.axis` 是字符串**，但 `trend.axis` 是数组 —— 两个接口不一样。
- **`/api/notices` 只返回 `reviewStatus = approved` 的通知**，
  未复核的采集结果不对外发布，这是硬约束。
- **查询类接口不需要登录**，只有 `/api/rules` 和 `/api/history` 需要。