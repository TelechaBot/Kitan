# Frontend

## `.env` Configuration

```dotenv
VITE_CLOUDFLARE_SITE_KEY=0x4AAAxxxxxxxxx
# Cloudflare Turnstile
VITE_BACKEND_URL=https://verify.dianas.cyou
# the backend url
```

## Recommended Setup

```shell
cd frontend
npm install
env VITE_BACKEND_URL="https://api.example.com"
# env VITE_CLOUDFLARE_SITE_KEY="optional"
npm run build
# Deploy to server
```