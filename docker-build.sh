# docker-build.sh
# frontend: Vite
export VITE_BACKEND_URL='/api'
export VITE_CLOUDFLARE_SITE_KEY='0x4AAAAAAAxxxxx' # Cloudflare Turnstile

# backend: FastAPI
export SERVER_HOST='0.0.0.0'
export SERVER_PORT='10100'
export CORS_ORIGIN='*'
export VERIFY_DOMAIN='verifyer.dianas.cyou'
export TELEGRAM_BOT_TOKEN='65655103:xxxxxx'
export CLOUDFLARE_SECRET_KEY='0x4AAAAAxxxxx' # Cloudflare Turnstile

# Nginx
# export NGINX_SERVER_NAME='verifyer.dianas.cyou'
# export SSL_CERTIFICATE_PATH='/etc/nginx/ssl/fullchain.pem'
# export SSL_CERTIFICATE_KEY_PATH='/etc/nginx/ssl/privkey.pem'

docker compose -f docker-compose.yml -p kitan up --build