# 油势后端对外域名配置

## 现状（已实测确认）

| 项 | 值 |
| --- | --- |
| 服务器 | 腾讯云 `124.221.89.106`，Ubuntu |
| DNS 托管 | Cloudflare（NS: peaches/harlan.ns.cloudflare.com） |
| 已跑服务 | `lyriclab-server`(3001)、`oil-trend-server`(3002) ✓ online、`openmaic` |
| 部署目录 | `/home/ubuntu/deploy/oil_trend`（下划线，不是连字符） |
| 现有证书 | `/etc/nginx/ssl/` 下两张**单域名**证书：
| | `jiuguan.uwakeme.top.crt`（有效期到 2036）、`lyric.lab.uwakeme.top_bundle.crt`（到 2026-08-31） |
| 过期证书 | `/etc/letsencrypt/live/moyu.uwakeme.top`（2026-10-14 过期，SAN 只有它自己） |

**没有任何一张是泛域名证书**（SAN 里只有单个域名），所以 `oil-trend.uwakeme.top`
必须单独签一张。

## 〇、最容易踩的坑：DNS 指错机器

certbot 报 `404` / `Invalid response`，**八成是 DNS 指到了另一台服务器**。

排查方法（在服务器上执行）：

```bash
echo '本机公网 IP:' && curl -4 -s https://api.ipify.org
echo '域名解析到:' && getent hosts oil-trend.uwakeme.top
```

两个值必须一致。

> 这个坑的表现很有迷惑性：nginx 配置完全正确、
> 服务器内部带 Host 头访问也是 200，但公网访问就是 404 ——
> 因为请求根本没到这台机器。

## 一、加 DNS 解析（Cloudflare）

在 Cloudflare 控制台 → `uwakeme.top` → DNS → Add record：

| Type | Name | Content | Proxy status |
| --- | --- | --- | --- |
| A | `oil-trend` | `124.221.89.106` | **DNS only**（灰云） |

**必须是 DNS only（灰云）**：Let's Encrypt 的 HTTP-01 校验需要直连服务器，
走 Cloudflare 代理会校验失败。

验证（等 DNS 生效，通常几分钟）：

```bash
nslookup oil-trend.uwakeme.top
```

解析出 `124.221.89.106` 即可继续。

## 〇、最省事：一键脚本

上面所有步骤都写成一个脚本了，直接跑：

```bash
curl -sO https://raw.githubusercontent.com/uwakeme/oil-trend/main/server/setup-domain.sh
bash setup-domain.sh
```

它会依次做完：检查 DNS → 放临时 80 站点 → 用 `certbot --nginx` 签证书 →
换成完整 443 配置 → 把 `OIL_API_BASE_URL` 写进 `.env` → 重启 pm2 → 验证。

脚本里的 nginx 配置已在真实服务器上用 `nginx -t` 验证过语法。

想换 certbot 邮箱：

```bash
CERTBOT_EMAIL=你的邮箱@example.com bash setup-domain.sh
```

## 二、签证书

### ⚠️ 必须用 `--nginx`，不能用 `--standalone`

在这台机器上试过 `--standalone`，**校验失败**：

```
Detail: 124.221.89.106: Invalid response from
  http://oil-trend.uwakeme.top/.well-known/acme-challenge/xxx: 404
```

原因在 certbot 日志里：

```
Successfully bound to :80 using IPv6
Certbot wasn't able to bind to :80 using IPv4, this is often expected
due to the dual stack nature of IPv6 socket implementation
```

**certbot 的 standalone 服务器只绑了 IPv6 的 `:80`，IPv4 绑不上** ——
而 Let's Encrypt 的校验服务器走 IPv4，于是请求打到了 nginx 的默认站点，拿到 404。

`--nginx` 走 nginx 自己的 80 端口，nginx 是 IPv4/IPv6 都监听的，能通过。

```bash
sudo certbot certonly --nginx -d oil-trend.uwakeme.top \
  --agree-tos --no-eff-email -m 你的邮箱@example.com
```

它会：临时改 nginx 配置放行校验 → 签发 → 自动还原 → 自动配好续期。

签完在 `/etc/letsencrypt/live/oil-trend.uwakeme.top/` 下生成
`fullchain.pem` 和 `privkey.pem`。

### 验证证书

```bash
sudo certbot certificates
```

应该能看到 `Certificate Name: oil-trend.uwakeme.top`，
`Expiry Date` 是将来时间（不是 EXPIRED）。

## 三、加 nginx 站点

### 先说顺序问题

完整配置里引用了 `/etc/letsencrypt/live/oil-trend.uwakeme.top/fullchain.pem`，
但证书是下一步才签的 —— 证书还不存在时 `nginx -t` 会直接失败，nginx 就起不来。

所以按这个顺序走：

**① 先放一个只监听 80 的临时站点**（不引用证书），并把校验目录暴露出来：

```bash
sudo mkdir -p /var/www/html/.well-known/acme-challenge
sudo tee /etc/nginx/sites-available/oil-trend > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name oil-trend.uwakeme.top;

    # certbot 校验与续期都走这里
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        # 证书还没签出来时先别跳 https
        return 301 https://$host$request_uri;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/oil-trend /etc/nginx/sites-enabled/oil-trend
sudo nginx -t && sudo systemctl reload nginx
```

**② 签证书**（用方案 A 的 `--nginx`）：

```bash
sudo certbot certonly --nginx -d oil-trend.uwakeme.top \
  --agree-tos --no-eff-email -m 你的邮箱@example.com
```

**③ 换成完整配置**（含 443 反代）：

```bash
sudo cp server/oil-trend.nginx.conf /etc/nginx/sites-available/oil-trend
sudo nginx -t && sudo systemctl reload nginx
```

> `server/oil-trend.nginx.conf` 在仓库里，包含 443 反代到 3002 的完整配置。
> 下载：`curl -sO https://raw.githubusercontent.com/uwakeme/oil-trend/main/server/oil-trend.nginx.conf`

## 四、补服务器上的 .env

现在 `.env` 里只有 `DATABASE_URL`（流水线自动建的）。要补四项：

```bash
sudo vi /home/ubuntu/deploy/oil_trend/server/.env
```

```
DATABASE_URL=postgresql://postgres:密码@127.0.0.1:5432/oil_trend
WX_APP_ID=wx你的AppID
WX_APP_SECRET=你的AppSecret
OIL_SUBSCRIBE_TEMPLATE_ID=你的订阅消息模板ID
OIL_TOKEN_SECRET=一串足够长的随机字符串
OIL_API_BASE_URL=https://oil-trend.uwakeme.top
PORT=3002
```

`OIL_API_BASE_URL` 就是**后端对外地址** —— 小程序请求它，健康检查也打它。
它必须和 nginx 的 `server_name` 一致。

改完重启：

```bash
cd /home/ubuntu/deploy/oil_trend/server && pm2 restart oil-trend-server
```

## 五、验证

```bash
curl https://oil-trend.uwakeme.top/health
# 期望：{"ok":true,"data":{"status":"up",...}}

curl https://oil-trend.uwakeme.top/api/regions
# 期望：31 个地区

curl https://oil-trend.uwakeme.top/api/home?regionCode=440000
# 期望：广东当前价，和小程序演示源一致
```

## 六、小程序侧

### config/index.js

```js
module.exports = {
  apiBaseUrl: 'https://oil-trend.uwakeme.top',
  subscribeTemplateIds: ['你的模板ID'],
  dataSource: 'auto'
}
```

### 公众平台

「开发管理」→「开发设置」→「服务器域名」→ **request 合法域名**
加上 `https://oil-trend.uwakeme.top`。

**不做这步，小程序端请求会被直接拦掉**，页面一直显示演示数据。

## 七、证书自动续期

certbot 自带 systemd timer，一般装完就有：

```bash
systemctl list-timers | grep certbot
```

没有的话手动加（每天检查一次）：

```bash
sudo tee /etc/cron.d/certbot-renew > /dev/null <<'EOF'
0 3 * * * root certbot renew --quiet --pre-hook 'systemctl stop nginx' --post-hook 'systemctl start nginx'
EOF
```

## 八、如果走 Cloudflare 代理（橙云）

证书签完之后可以改成橙云，但要额外在 Cloudflare 里把
SSL/TLS 模式设成 **Full (strict)**，不能是 Flexible。

橙云的好处是隐藏源站 IP、挡 DDoS；坏处是请求多绕一跳。
油势的量小，**灰云更省事**，先用灰云跑通再说。