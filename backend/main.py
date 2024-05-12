import asyncio
import os
import sys

from dotenv import load_dotenv
from loguru import logger

from bot.controller import BotRunner, execution_ground
from server import run_server

load_dotenv()
# 移除默认的日志处理器
logger.remove()
# 添加标准输出
handler_id = logger.add(sys.stderr, level="INFO" if not os.getenv("DEBUG") else "DEBUG")
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
    TelegramBot = BotRunner()

    await asyncio.gather(
        TelegramBot.run(),
        run_server(),
        execution_ground()
    )


loop = asyncio.new_event_loop()
loop.run_until_complete(run_app())
