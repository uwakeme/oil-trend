# 油势后端对外域名配置

## 现状（已实测确认）

| 项 | 值 |
| --- | --- |
| 服务器 | 腾讯云 `124.221.89.106`，Ubuntu |
| DNS 托管 | Cloudflare（NS: peaches/harlan.ns.cloudflare.com） |
| 已跑服务 | `lyriclab-server`(3001)、`oil-trend-server`(3002) ✓ online、`openmaic` |
| 现有证书 | `/etc/nginx/ssl/` 下两张**单域名**证书：
| | `jiuguan.uwakeme.top.crt`（有效期到 2036）、`lyric.lab.uwakeme.top_bundle.crt`（到 2026-08-31） |
| 过期证书 | `/etc/letsencrypt/live/moyu.uwakeme.top`（2026-10-14 过期，SAN 只有它自己） |

**没有任何一张是泛域名证书**（SAN 里只有单个域名），所以 `oil-trend.uwakeme.top`
必须单独签一张。

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

## 二、签证书

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot certonly --standalone -d oil-trend.uwakeme.top \
  --agree-tos --no-eff-email -m 你的邮箱@example.com
```

签完会在 `/etc/letsencrypt/live/oil-trend.uwakeme.top/` 下生成
`fullchain.pem` 和 `privkey.pem`。

> 如果 80 端口被 nginx 占着导致签不了，先临时停 nginx：
> `sudo systemctl stop nginx` → 签完 → `sudo systemctl start nginx`

## 三、加 nginx 站点

```bash
sudo tee /etc/nginx/sites-available/oil-trend > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name oil-trend.uwakeme.top;

    # certbot 续期用，改完记得 nginx -s reload
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name oil-trend.uwakeme.top;

    ssl_certificate     /etc/letsencrypt/live/oil-trend.uwakeme.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/oil-trend.uwakeme.top/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # 小程序请求体不大，但通知接口偶尔带长文本
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/oil-trend /etc/nginx/sites-enabled/oil-trend
sudo nginx -t && sudo systemctl reload nginx
```

## 四、补服务器上的 .env

现在 `.env` 里只有 `DATABASE_URL`（流水线自动建的）。要补四项：

```bash
sudo vi /var/www/oil-trend/server/.env
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
cd /var/www/oil-trend/server && pm2 restart oil-trend-server
```

## 五、验证

```bash
curl https://oil-trend.uwakeme.top/health
# 期望：{"ok":true,"data":{"status":"up",...}}

curl https://oil-trend.uwakeme.top/api/regions
# 期望：10 个地区

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