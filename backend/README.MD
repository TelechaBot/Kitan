# Deploy

## Installation

```shell
cd backend

cp .env.example .env
nano .env

pip install pdm
pdm install
pdm run python main.py
# Press Ctrl + C to exit
pm2 start pm2.json
```

## .env

```dotenv
SERVER_HOST=0.0.0.0
SERVER_PORT=10100
CLOUDFLARE_SECRET_KEY=0x4AAAAA
# Cloudflare Turnstile
VERIFY_DOMAIN=verifyer.dianas.cyou
# cors
TELEGRAM_BOT_TOKEN=65655103
```

## Command

```shell
verify - Verify Step
start - Start
join_check - Enable/Disable Join Check
anti_spam - Anti Spam in Chat
complaints_guide - Set complaints_guide when joincheck failed
```