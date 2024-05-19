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

## Command

```shell
verify - Verify Step
start - Start
join_check - Enable/Disable Join Check
anti_spam - Anti Spam in Chat
complaints_guide - Set complaints_guide when joincheck failed
```