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
# 流程：停 nginx → certbot --standalone 签证书（独占 80 端口）→
#       写完整 nginx 配置 → 启动 nginx → 写 .env → 重启服务 → 验证

set -e

DOMAIN=oil-trend.uwakeme.top
DEPLOY_DIR=/var/www/oil-trend
EMAIL=${CERTBOT_EMAIL:-admin@uwakeme.top}

# 兜底：脚本中途失败时也要把 nginx 拉起来，
# 否则 lyric-lab / jiuguan 会一直不可访问
cleanup() {
  if ! sudo systemctl is-active --quiet nginx; then
    echo ''
    echo '>>> 确保 nginx 被启动...'
    sudo systemctl start nginx || true
  fi
}
trap cleanup EXIT

echo '=== 1. 检查 DNS ==='
getent hosts $DOMAIN || {
  echo '✗ DNS 还没解析生效，等几分钟再试'
  exit 1
}

echo '=== 2. 停 nginx（standalone 需要独占 80 端口）==='
sudo systemctl stop nginx
sleep 1
echo '✓ nginx 已停'

echo '=== 3. 签证书 ==='
if [ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  echo '证书已存在，跳过签发'
else
  sudo certbot certonly --standalone -d $DOMAIN \
    --agree-tos --no-eff-email --non-interactive -m $EMAIL
fi

echo '=== 4. 写完整 nginx 配置（80 跳 https + 443 反代）==='
cat > /tmp/oil-trend-full.conf <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    # certbot 续期走这里，改完记得 nginx -s reload
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
sudo mkdir -p /var/www/html/.well-known/acme-challenge
sudo cp /tmp/oil-trend-full.conf /etc/nginx/sites-available/oil-trend
sudo ln -sf /etc/nginx/sites-available/oil-trend /etc/nginx/sites-enabled/oil-trend
rm -f /tmp/oil-trend-full.conf
echo '✓ 配置已写入'

echo '=== 5. 启动 nginx ==='
sudo nginx -t
sudo systemctl start nginx
sleep 1
echo '✓ nginx 已启动'

echo '=== 6. 续期改成 webroot（免得每次续期都停 nginx）==='
RENEW_CONF=/etc/letsencrypt/renewal/$DOMAIN.conf
if [ -f $RENEW_CONF ]; then
  sudo sed -i 's/^authenticator = standalone/authenticator = webroot/' $RENEW_CONF
  if ! grep -q '^webroot_path' $RENEW_CONF; then
    sudo sed -i "s/^authenticator = webroot/authenticator = webroot\nwebroot_path = \/var\/www\/html,/" $RENEW_CONF
  fi
  echo '✓ 续期已改为 webroot'
else
  echo '!! 没找到 renewal 配置，续期方式保持原样'
fi

echo '=== 7. 写 OIL_API_BASE_URL 到 .env ==='
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

echo '=== 8. 重启服务 ==='
cd $DEPLOY_DIR/server && pm2 restart oil-trend-server

echo '=== 9. 验证 ==='
sleep 3
printf '本地: '
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/health || echo 000
echo ''
printf '公网: '
curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/health || echo 000
echo ''
curl -s https://$DOMAIN/health || true
echo ''
echo '如果公网是 000，检查：'
echo '  - Cloudflare 是不是灰云（橙云会让 Lets Encrypt 校验失败）'
echo '  - nginx 站点是否启用：ls -la /etc/nginx/sites-enabled/'
echo '  - 日志：sudo tail -20 /var/log/nginx/error.log'