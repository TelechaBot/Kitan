# docker-build.sh
export VITE_CLOUDFLARE_SITE_KEY='0x4AAAAAAAZpMmyEcy3nfzIa'
export VITE_BACKEND_URL='/api'

export SERVER_HOST='0.0.0.0'
export SERVER_PORT='10100'
export CLOUDFLARE_SECRET_KEY='0x4AAAAA'
export VERIFY_DOMAIN='https://verifyer.dianas.cyou'
export TELEGRAM_BOT_TOKEN='65655103:xxxxxx'

export NGINX_SERVER_NAME='yourdomain.com'
export SSL_CERTIFICATE_PATH='/etc/nginx/ssl/fullchain.pem'
export SSL_CERTIFICATE_KEY_PATH='/etc/nginx/ssl/privkey.pem'

docker-compose up -d