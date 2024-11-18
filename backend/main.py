import asyncio
import os
import sys

import uvicorn
from dotenv import load_dotenv
from loguru import logger

from bot.controller import Runner, execution_ground
from server import app
from setting.server import ServerSetting

load_dotenv()
# 移除默认的日志处理器
logger.remove()
# 添加标准输出
handler_id = logger.add(
    sys.stderr,
    level="INFO" if not os.getenv("DEBUG") else "DEBUG",
    format="{time} - {level} - {message}",
)
# 添加文件写出
logger.add(
    sink="run.log",
    format="{time} - {level} - {message}",
    level="INFO",
    rotation="100 MB",
    enqueue=True,
)
logger.info("Log Is Secret, Please Don't Share It To Others")


async def run_app():
    logger.info("Backend Server Start")

    server = uvicorn.Server(
        config=uvicorn.Config(app, host=ServerSetting.host, port=ServerSetting.port, loop="asyncio")
    )
    TelegramBot = Runner()
    await asyncio.gather(
        TelegramBot.run(),
        execution_ground(),
        server.serve()
    )


loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
loop.run_until_complete(run_app())
