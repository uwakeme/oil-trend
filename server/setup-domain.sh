#!/bin/bash
# 油价势后端域名配置 —— **只做只读检查 + 打印命令清单，不代改任何东西**
#
# 为什么改成这样：
#   这台服务器上还跑着别的线上服务（lyric-lab / jiuguan / openmaic）。
#   原来这个脚本会无条件覆盖 /etc/nginx/sites-available/oil-trend、
#   全局 reload nginx、再跑 certbot --nginx ——
#   覆盖前没有备份，目标文件里别人的手写配置会整个丢掉；
#   certbot 校验期间会临时改写并 reload nginx，脚本 set -e 中途失败的话，
#   nginx 可能停在中间态。
#
#   按项目约定（AGENTS.md）：涉及改 nginx / 写 /etc / 装证书的操作，
#   **只给命令让维护者自己执行**。这个脚本现在只做只读检查，
#   把命令按顺序打印出来，照着敲一遍就行。
#
# 用法：
#   bash setup-domain.sh          # 只读检查 + 打印命令清单
#
# 前置条件：
#   1. DNS 已把 oil-trend.uwakeme.top 解析到这台服务器（Cloudflare 灰云）
#   2. 部署流水线已经跑过一次（否则没有 .env 和 pm2 进程）

DOMAIN=oil-trend.uwakeme.top
DEPLOY_DIR=/home/ubuntu/deploy/oil_trend
EMAIL=${CERTBOT_EMAIL:-admin@uwakeme.top}

echo '=== 只读检查 ==='

echo '-- 1. DNS 解析到的是不是本机 --'
MY_IP=$(curl -4 -s --max-time 8 https://api.ipify.org || true)
DOMAIN_IP=$(getent hosts $DOMAIN | awk '{print $1}' | head -1)
echo "  本机公网 IP: ${MY_IP:-取不到}"
echo "  $DOMAIN 解析到: ${DOMAIN_IP:-解析失败}"
if [ -n "$MY_IP" ] && [ -n "$DOMAIN_IP" ] && [ "$MY_IP" != "$DOMAIN_IP" ]; then
  echo '  ✗ DNS 指到了别的机器，先把 A 记录改成本机 IP，否则证书一定签不下来。'
else
  echo '  ✓ DNS 指向正确'
fi

echo '-- 2. 现有站点配置 --'
if [ -f /etc/nginx/sites-available/oil-trend ]; then
  echo "  存在：/etc/nginx/sites-available/oil-trend（$(wc -l < /etc/nginx/sites-available/oil-trend) 行）"
  echo '  ⚠ 下面的命令会覆盖它 —— 覆盖前一定先备份。'
else
  echo '  还没有这个站点配置（首次部署）。'
fi

echo '-- 3. 证书 --'
if [ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  echo "  ✓ 证书已存在：/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  echo '  → 跳过第 4 步签发，直接做第 5 步（换完整配置）。'
else
  echo '  还没签过证书 → 需要走第 4 步。'
fi

echo '-- 4. 后端进程 --'
if command -v pm2 > /dev/null 2>&1; then
  pm2 list 2>/dev/null | grep -E 'oil-trend|online|error' || echo '  pm2 里没找到 oil-trend-server'
else
  echo '  没装 pm2？后端可能没部署。'
fi

echo
echo '=== 接下来的命令（请自己逐条执行）==='

cat <<'CMDS'

--- 步骤 1：备份现有配置（一定要先做） ---
sudo cp /etc/nginx/sites-available/oil-trend /etc/nginx/sites-available/oil-trend.bak.$(date +%Y%m%d-%H%M%S)
# 如果上面的文件不存在会报错，属正常（首次部署）

--- 步骤 2：写临时站点（只有 80 端口，供 certbot 校验用） ---
sudo mkdir -p /var/www/html/.well-known/acme-challenge
sudo tee /etc/nginx/sites-available/oil-trend > /dev/null <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name oil-trend.uwakeme.top;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
CONF
sudo ln -sf /etc/nginx/sites-available/oil-trend /etc/nginx/sites-enabled/oil-trend
sudo nginx -t && sudo systemctl reload nginx

--- 步骤 3：自测校验路径能不能通（不通就别签证书） ---
echo 'probe-content' | sudo tee /var/www/html/.well-known/acme-challenge/probe.txt > /dev/null
curl -s --max-time 8 http://oil-trend.uwakeme.top/.well-known/acme-challenge/probe.txt
sudo rm -f /var/www/html/.well-known/acme-challenge/probe.txt
# 期望输出 probe-content；拿不到就是 DNS 没生效或被 Cloudflare 代理了（橙云）

--- 步骤 4：签证书 ---
# 用 --nginx 不用 --standalone：这台机器是双栈的，
# certbot standalone 只绑 IPv6 的 :80，IPv4 绑不上
# （日志：Certbot wasn't able to bind to :80 using IPv4），
# 而 Let's Encrypt 的校验服务器走 IPv4，于是拿到 404、校验失败。
sudo certbot certonly --nginx -d oil-trend.uwakeme.top \
  --agree-tos --no-eff-email --non-interactive -m admin@uwakeme.top

--- 步骤 5：换成完整配置（443 + 反代） ---
sudo tee /etc/nginx/sites-available/oil-trend > /dev/null <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name oil-trend.uwakeme.top;

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
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

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
CONF
sudo nginx -t && sudo systemctl reload nginx

--- 步骤 6：写 OIL_API_BASE_URL 到 .env ---
grep -q '^OIL_API_BASE_URL=' /home/ubuntu/deploy/oil_trend/server/.env \
  && sudo sed -i "s#^OIL_API_BASE_URL=.*#OIL_API_BASE_URL=https://oil-trend.uwakeme.top#" /home/ubuntu/deploy/oil_trend/server/.env \
  || echo "OIL_API_BASE_URL=https://oil-trend.uwakeme.top" | sudo tee -a /home/ubuntu/deploy/oil_trend/server/.env

--- 步骤 7：重启后端（它会读新的 .env） ---
cd /home/ubuntu/deploy/oil_trend/server && pm2 restart oil-trend-server

--- 步骤 8：验证（/ready 会真的连库，/health 只说明进程活着） ---
curl -s -o /dev/null -w '本地 %{http_code}\n' http://127.0.0.1:3002/ready
curl -s -o /dev/null -w '公网 %{http_code}\n' https://oil-trend.uwakeme.top/ready

CMDS

echo '（以上命令涉及 nginx、/etc、证书与 pm2，请自行执行并留意输出）'