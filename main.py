import asyncio
import os
import sys

from dotenv import load_dotenv
from loguru import logger

from bot import Runner, execution_ground

load_dotenv()

logger.remove()
handler_id = logger.add(sys.stderr, level="INFO" if not os.getenv("DEBUG") else "DEBUG",
                        format="{time} - {level} - {message}")
logger.add(sink="bot.log", format="{time} - {level} - {message}", level="INFO", rotation="100 MB", enqueue=True)
logger.info("Log file may contain sensitive information, do not share it with others.")


async def run_app():
    logger.info("Backend Server Start")
    TelegramBot = Runner()
    await asyncio.gather(
        TelegramBot.run(),
        execution_ground(),
    )

loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
loop.run_until_complete(run_app())
