![Kitan](https://github.com/TelechaBot/Kitan/blob/main/.github/cover.webp?raw=true)
---
<p align="center">
  <img alt="License" src="https://img.shields.io/badge/LICENSE-Apache%202.0-blue.svg" />
  <img src="https://img.shields.io/badge/Python-3.9%2B-green.svg" alt="Python 3.9+" />
  <a href="https://github.com/TelechaBot/Kitan/releases"><img src="https://img.shields.io/github/v/release/TelechaBot/Kitan?style=plastic" alt="Version" ></a>
</p>

# 🌟 Kitan

**Kitan** is a Telegram bot guardian responsible for ensuring that users are friendly real human beings. It is an
open-source project developed using Python and Vue.

👋 User-friendly and incorporating risk control technology, Kitan provides a safe and pleasant chat environment,
effectively preventing personal attacks and advertisements from real human harassments.

[Invite the bot to your group](https://t.me/SmartVerifyBot?startgroup&admin=can_invite_users+restrict_members+delete_messages)

### 🚀 Why Choose Kitan

Traditional verification methods like captchas, security questions, and puzzles can be circumvented with human
assistance. Moreover, not all advertisement senders are bots; real users may also send ads.

Hence, we need a verification method tailored to the current environment, ensuring that users are within the platform
and have undergone self-defense testing.

Kitan achieves this by using quick fingerprint verification and puzzle proof-of-work within the authentication mechanism
to ensure users are real humans.

Additionally, Kitan employs risk control techniques, combining LLM/NLP/big data technologies for AI behavior analysis,
monitoring user behavior from joining to leaving groups, effectively preventing personal attacks and real human
advertisement harassment.

## 🛡️ Verification Methods

- [x] Biometric live authentication
- [x] Puzzle proof-of-work verification

## 📚 How to Use

1. Add the bot to your group
2. Set the bot as an administrator
3. Grant the bot the necessary permissions
4. The bot will automatically review new group members

The bot implements an approval-based invite mechanism, allowing only approved users to join the group, preventing
situations where user approvals are hindered due to bot malfunctions.

## 🛣️ Roadmap

- [x] Implement basic verification
- [ ] Risk control system/ban monitoring/pre-inspection
- [ ] Group consensus
- [ ] Persistent tokens/Github-hosted verification

## 📦 Deploying Your Own Instance

You will need a server with `Redis` and `MongoDB` installed, a domain, and a Telegram bot.

```shell
git clone https://github.com/TelechaBot/Kitan
cd Kitan
```

**Frontend**

```shell
cd frontend
npm install
env VITE_BACKEND_URL="https://api.example.com"
npm run build
# Deploy to server
```

**Backend**

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
