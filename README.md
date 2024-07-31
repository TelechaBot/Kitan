![Kitan](https://github.com/TelechaBot/Kitan/blob/main/.github/project_cover.webp?raw=true)

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/LICENSE-Apache%202.0-blue.svg" />
  <img src="https://img.shields.io/badge/Python-3.9%2B-green.svg" alt="Python 3.9+" />
  <a href="https://github.com/TelechaBot/Kitan/releases"><img src="https://img.shields.io/github/v/release/TelechaBot/Kitan?style=plastic" alt="Version" ></a>
</p>

# 🌟 Kitan

**Kitan** is a Telegram bot that helps keep your group safe by verifying that users are real people. It's open-source
and built with Python and Vue.

[Invite the bot to your group](https://t.me/SmartVerifyBot?startgroup&admin=can_invite_users+restrict_members+delete_messages)

## 🚀 Why Kitan?

Many traditional verification methods like captchas and questions can be bypassed with human help. Plus, not all
spammers are bots—some are real people.

Kitan uses modern methods to verify users, ensuring they're genuine. It combines biometric authentication and puzzles to
verify users and employs AI to monitor user behavior for risks.

## 🛡️ How It Works

- **Biometric Live Authentication**: Confirms the user is a real, living person.
- **Puzzle Verification**: Ensures users solve a puzzle to prove they're human.
- **Cloudflare Turnstile**: Blocks users who exhibit risky behavior. If the biometric API is unavailable, fallback
  methods like Cloudflare's protection and puzzle verification are used.
- **OCR Trash Message Detection**: Identifies and intercepts spam messages using OCR.

## 📚 Getting Started

1. Add Kitan to your Telegram group.
2. Make Kitan an administrator with the right permissions.
3. Kitan will automatically screen new members.

This keeps your group safe by ensuring only approved users can join.

## 🛣️ Roadmap

- [x] Basic verification
- [x] Risk control and ban monitoring
- [x] Group consensus features

## 📦 Deploying Kitan

To deploy Kitan yourself, you'll need a server, `Redis` (optional), `MongoDB`, a domain, and a Telegram bot.

### Docker

```shell
git clone https://github.com/TelechaBot/Kitan
cd Kitan
nano docker-build.sh
# Change the environment variables
./docker-build.sh
```

check [docker-build.sh](./docker-build.sh) for more information.

### Clone the Repository

```shell
git clone https://github.com/TelechaBot/Kitan
cd Kitan
```

### Frontend Setup

See `/frontend/README.MD`.

```shell
cd frontend
npm install
env VITE_BACKEND_URL="https://api.example.com"
# env VITE_CLOUDFLARE_SITE_KEY="optional"
npm run build
# Deploy to your server
```

### Backend Setup

See `/backend/README.MD`.

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

---

![anime](https://github.com/TelechaBot/Kitan/blob/main/.github/anime.webp?raw=true)
> This image is decorative and not part of the project.
