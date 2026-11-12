# 后端部署（GitHub Actions）

后端部署到自己的服务器，流水线参考 `lyric_lab` 的 `.github/workflows/deploy.yml`，
但去掉了前端构建（小程序不走这条流水线），后端是纯 JS 也不用编译。

工作流：`.github/workflows/deploy-backend.yml`

## 一、需要配置的 Secrets

### ⚠️ Environment secrets 必须配在 workflow 声明过的 environment 里

工作流里有一行：

```yaml
jobs:
  deploy:
    environment: 腾讯云
```

**没有这一行，Environment secrets 不会被注入 job** —— `${{ secrets.SERVER_HOST }}`
会展开成空字符串，报出来的错长这样：

```
ssh -o StrictHostKeyChecking=no -i /tmp/deploy_key -p 22 @ "mkdir -p ..."
usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] ...
```

看着像 ssh 用法写错了，其实是 host 和 user 都是空的。

### Secret 清单

本项目把这些配在 **Environment secrets**（environment 名：`腾讯云`），
`DATABASE_URL` 配在 Repository secrets —— 两种都能用，声明了 environment 后
Repository secrets 依然可见。

| Secret | 放哪 | 说明 |
| --- | --- | --- |
| `SERVER_HOST` | Environment | 服务器 IP 或域名 |
| `SERVER_USER` | Environment | SSH 用户（参考项目用 `ubuntu`） |
| `SERVER_PORT` | Environment | SSH 端口，默认 22 |
| `SERVER_SSH_KEY` | Environment | **服务器私钥全文**，含 `-----BEGIN OPENSSH PRIVATE KEY-----` 头尾 |
| `DEPLOY_DIR` | Environment | 部署目录，默认 `/var/www/oil-trend` |
| `DATABASE_URL` | Repository | PostgreSQL 连接串。**注意库名要换**：参考项目是 `lyric_lab`，油势要用独立的库（如 `oil_trend`） |
| `OIL_API_BASE_URL` | Environment（可选） | 后端对外地址，健康检查用。没配就退回查服务器本地端口 `127.0.0.1:3002` |

命令行配 Environment secret：

```bash
gh secret set SERVER_HOST --repo uwakeme/oil-trend --env 腾讯云
gh secret set SERVER_SSH_KEY --repo uwakeme/oil-trend --env 腾讯云
```

`SERVER_SSH_KEY` 的内容是服务器上那把私钥（如 `~/.ssh/id_ed25519`）的全文。
拿法：`cat ~/.ssh/id_ed25519`（在服务器上执行，**注意这等于把私钥交出去**）。

## 二、服务器上要准备好的

### 1. 数据库

油势用独立的库，不要和 `lyric_lab` 混：

```bash
sudo -u postgres psql -c "CREATE DATABASE oil_trend;"
```

建表由流水线自动执行（`node scripts/apply-schema.js`），
`schema.sql` 全是 `CREATE TABLE IF NOT EXISTS`，重复跑安全。

### 2. .env

流水线**只在缺失时**创建 `.env`，且只写 `DATABASE_URL`。
剩下的必须手动补 —— 这些是密钥，CI 里没有也不该有：

```bash
sudo -vi /var/www/oil-trend/server/.env
```

```
DATABASE_URL=postgresql://postgres:密码@localhost:5432/oil_trend
WX_APP_ID=wx你的AppID
WX_APP_SECRET=你的AppSecret
OIL_SUBSCRIBE_TEMPLATE_ID=你的模板ID
OIL_TOKEN_SECRET=一串足够长的随机字符串
PORT=3002
```

### 3. Nginx 反代 + HTTPS

小程序只认 **HTTPS + 已备案域名**，所以后端必须挂在域名后面：

```nginx
server {
    listen 443 ssl http2;
    server_name api.你的域名;

    ssl_certificate     /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置完 `nginx -t && nginx -s reload`。

## 三、公众平台配 request 合法域名

公众平台 →「开发管理」→「开发设置」→「服务器域名」→「request 合法域名」
加上 `https://api.你的域名`。

**不做这步，小程序端请求会被直接拦掉**，页面会一直显示演示数据。

## 四、前端指向

`config/index.js`：

```js
module.exports = {
  apiBaseUrl: 'https://api.你的域名',
  subscribeTemplateIds: ['你的模板ID'],
  dataSource: 'auto'
}
```

## 五、触发部署

推 `main` 分支且改动命中 `server/**` 时自动触发；也可以手动触发：

```bash
gh workflow run deploy-backend.yml --repo uwakeme/oil-trend
```

**注意：改 secret 不会触发流水线**（触发条件只看代码路径），
所以配完 secret 后一定要手动触发一次。

看日志：

```bash
gh run list --repo uwakeme/oil-trend
gh run watch --repo uwakeme/oil-trend
```

## 六、流水线做了什么

1. 装依赖（`npm ci`）
2. **跑自检**（`npm test`，66 项）—— 结构或 HTTP 契约不对就直接失败，不部署
3. SSH 上传 `server/`（src、scripts、package.json、schema.sql、pm2 配置）
4. 服务器上：建表 → `pm2 delete` 旧进程 → `npm install --omit=dev` → `pm2 start`
5. 健康检查打 `OIL_API_BASE_URL/health`，不通过则整条流水线失败

## 七、端口

油势用 **3002**，避开 `lyric_lab` 的 3001，两套在同一台机器上互不干扰。
PM2 配置在 `server/oil-trend-pm2.json`，改端口改这个文件。

## 八、出问题先看这里

| 现象 | 多半是 |
| --- | --- |
| `ssh ... @ "mkdir -p ..."` + usage 报错 | **Environment secrets 没被注入** —— workflow 里少了 `environment: 腾讯云` 这行 |
| 流水线卡在自检 | 代码改坏了，先本地 `cd server && npm test` |
| 健康检查 404 | Nginx 没配好，或 `OIL_API_BASE_URL` 写错 |
| 小程序一直显示演示数据 | request 合法域名没配，或 `apiBaseUrl` 没填 |
| 登录失败 | 服务器 `.env` 里缺 `WX_APP_ID` / `WX_APP_SECRET` |
| 提醒不下发 | `.env` 缺 `OIL_SUBSCRIBE_TEMPLATE_ID`，或模板字段名对不上 |
| 服务启动就退 | `.env` 缺 `DATABASE_URL`，或数据库不存在 |