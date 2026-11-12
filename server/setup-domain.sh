#!/bin/bash
# 油势后端域名配置 —— 一次执行完
#
# 用法：
#   curl -sO https://raw.githubusercontent.com/uwakeme/oil-trend/main/server/setup-domain.sh
#   bash setup-domain.sh
#
# 前置条件：
#   1. Cloudflare 已加 A 记录 oil-trend → 服务器 IP（必须是灰云）
#   2. 部署流水线已经跑过一次（否则没有 .env 和 pm2 进程）
#
# 为什么用 certbot --nginx 而不是 --standalone：
#   这台机器是双栈的。certbot standalone 只绑 IPv6 的 :80，
#   IPv4 绑不上（日志：Certbot wasn't able to bind to :80 using IPv4），
#   而 Let's Encrypt 的校验服务器走 IPv4，于是拿到 404、校验失败。
#   --nginx 走 nginx 自己的 80 端口，nginx 是 IPv4/IPv6 都监听的，能通过。

set -e

DOMAIN=oil-trend.uwakeme.top
DEPLOY_DIR=/var/www/oil-trend
EMAIL=${CERTBOT_EMAIL:-admin@uwakeme.top}

echo '=== 1. 检查 DNS ==='
getent hosts $DOMAIN || {
  echo '✗ DNS 还没解析生效，等几分钟再试'
  exit 1
}

echo '=== 2. 放一个只监听 80 的临时站点（certbot --nginx 需要它）==='
sudo mkdir -p /var/www/html/.well-known/acme-challenge
cat > /tmp/oil-trend-http.conf <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

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
sed -i "s/__DOMAIN__/$DOMAIN/" /tmp/oil-trend-http.conf
sudo cp /tmp/oil-trend-http.conf /etc/nginx/sites-available/oil-trend
sudo ln -sf /etc/nginx/sites-available/oil-trend /etc/nginx/sites-enabled/oil-trend
rm -f /tmp/oil-trend-http.conf
sudo nginx -t
sudo systemctl reload nginx
echo '✓ 临时站点已生效'

echo '=== 3. 签证书（--nginx 模式）==='
if [ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  echo '证书已存在，跳过签发'
else
  sudo certbot certonly --nginx -d $DOMAIN \
    --agree-tos --no-eff-email --non-interactive -m $EMAIL
fi

echo '=== 4. 换成完整配置（443 + 反代）==='
cat > /tmp/oil-trend-full.conf <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

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
    server_name __DOMAIN__;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
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
sed -i "s/__DOMAIN__/$DOMAIN/g" /tmp/oil-trend-full.conf
sudo cp /tmp/oil-trend-full.conf /etc/nginx/sites-available/oil-trend
rm -f /tmp/oil-trend-full.conf
sudo nginx -t
sudo systemctl reload nginx
echo '✓ 完整配置已生效'

echo '=== 5. 写 OIL_API_BASE_URL 到 .env ==='
if [ -f $DEPLOY_DIR/server/.env ]; then
  if grep -q '^OIL_API_BASE_URL=' $DEPLOY_DIR/server/.env; then
    sudo sed -i "s#^OIL_API_BASE_URL=.*#OIL_API_BASE_URL=https://$DOMAIN#" $DEPLOY_DIR/server/.env
  else
    echo "OIL_API_BASE_URL=https://$DOMAIN" | sudo tee -a $DEPLOY_DIR/server/.env > /dev/null
  fi
  echo '✓ .env 已更新'
else
  echo "!! 没找到 $DEPLOY_DIR/server/.env —— 先跑一次部署流水线生成它"
fi

echo '=== 6. 重启服务 ==='
cd $DEPLOY_DIR/server && pm2 restart oil-trend-server

echo '=== 7. 验证 ==='
sleep 3
printf '本地: '
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/health || echo 000
echo ''
printf '公网: '
curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/health || echo 000
echo ''
curl -s https://$DOMAIN/health || true
echo ''
echo '如果公网是 000：'
echo '  - nginx 错误日志：sudo tail -20 /var/log/nginx/error.log'
echo '  - 证书是否签到：sudo certbot certificates'