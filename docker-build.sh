# docker-build.sh
# frontend: Vite
export VITE_BACKEND_URL='https://verify.dianas.cyou' # Backend Domain
export VITE_CLOUDFLARE_SITE_KEY='0x4AAAAAAAxxxxx' # Cloudflare Turnstile
export HTTPS_ENABLED=false # HTTPS
# if https,ensure ssl/server.crt ssl/server.key


# backend: FastAPI
export SERVER_HOST='0.0.0.0' # Host(DO NOT CHANGE)
export SERVER_PORT='10101' # Expose Port
export CORS_ORIGIN='*'
export VERIFY_DOMAIN='verifyer.dianas.cyou' # Frontend Domain
export TELEGRAM_BOT_TOKEN='65655103:xxxxxx' # Telegram Bot Token
export CLOUDFLARE_SECRET_KEY='0x4AAAAAxxxxx' # Cloudflare Turnstile

# Build Frontend
if [ $HTTPS_ENABLED = true ]; then
  echo "You need server.crt and server.key in ./ssl/"
else
  echo "You need https for webapp, so you cant run without https, pls goto cloudflare to generate a free ssl"
  echo "You also need a domain to use cloudflare!"
fi


:<<!
你可能需要根据实际情况调整 proxy_pass 的端口号。
CONTAINER ID   IMAGE     COMMAND                  CREATED          STATUS          PORTS                                       NAMES
db07a9f3d3d3   kitan_frontend   "npm start"    10 minutes ago   Up 10 minutes   0.0.0.0:3000->3000/tcp         kitan_frontend_1
location / {
        proxy_pass http://kitan_frontend_1:3000; # 根据 docker-compose 服务命名
}
!

echo "You need configure the proxy_pass in nginx.conf"
# docker compose -f docker-compose.yml -p kitan up --build

# Run in Backend
docker compose -f docker-compose.yml -p kitan up -d --build