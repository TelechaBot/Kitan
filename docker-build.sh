# docker-build.sh
# frontend: Vite
export VITE_BACKEND_URL='verify.dianas.cyou' # Backend Domain
export VITE_CLOUDFLARE_SITE_KEY='0x4AAAAAAAxxxxx' # Cloudflare Turnstile

# backend: FastAPI
export SERVER_HOST='0.0.0.0' # Host(DO NOT CHANGE)
export SERVER_PORT='10100' # Expose Port
export CORS_ORIGIN='*'
export VERIFY_DOMAIN='verifyer.dianas.cyou' # Frontend Domain
export TELEGRAM_BOT_TOKEN='65655103:xxxxxx' # Telegram Bot Token
export CLOUDFLARE_SECRET_KEY='0x4AAAAAxxxxx' # Cloudflare Turnstile

# Nginx
# export NGINX_SERVER_NAME='verifyer.dianas.cyou'
# export SSL_CERTIFICATE_PATH='/etc/nginx/ssl/fullchain.pem'
# export SSL_CERTIFICATE_KEY_PATH='/etc/nginx/ssl/privkey.pem'

docker compose -f docker-compose.yml -p kitan up --build