# docker-build.sh
export VITE_CLOUDFLARE_SITE_KEY='0x4AAAAAAAxxxxx' # Cloudflare Turnstile
export VITE_BACKEND_URL='/api'

export SERVER_HOST='0.0.0.0'
export SERVER_PORT='10100'
export CLOUDFLARE_SECRET_KEY='0x4AAAAAxxxxx' # Cloudflare Turnstile
export VERIFY_DOMAIN='verifyer.dianas.cyou'
export TELEGRAM_BOT_TOKEN='65655103:xxxxxx'

export NGINX_SERVER_NAME='verifyer.dianas.cyou'
export SSL_CERTIFICATE_PATH='/etc/nginx/ssl/fullchain.pem'
export SSL_CERTIFICATE_KEY_PATH='/etc/nginx/ssl/privkey.pem'

docker compose up -d