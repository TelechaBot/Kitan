import os

import dramatiq
from dotenv import load_dotenv
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import AsyncIO
from telebot import types
from telebot.async_telebot import AsyncTeleBot
from telebot.asyncio_storage import StateMemoryStorage
from telebot.types import InlineKeyboardMarkup

from common.cache import global_cache_runtime

load_dotenv()
bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
telegram_bot = AsyncTeleBot(bot_token, state_storage=StateMemoryStorage())
redis_broker = RedisBroker(url=global_cache_runtime.dsn)
dramatiq.set_broker(redis_broker)
redis_broker.add_middleware(AsyncIO())


# 定义任务
@dramatiq.actor(max_retries=3, time_limit=1000 * 30)
async def send_message(chat_id, text, button_text=None, button_link=None, web_app=None):
    print(f"Sending message to chat_id {chat_id}: {text}")
    try:
        reply_markup = None
        if button_text and button_link:
            reply_markup = InlineKeyboardMarkup()
            reply_markup.add(
                types.InlineKeyboardButton(
                    text=button_text,
                    url=button_link
                )
            )
        if button_text and web_app:
            reply_markup = InlineKeyboardMarkup()
            reply_markup.add(
                types.InlineKeyboardButton(
                    text=button_text,
                    web_app=web_app
                )
            )
        return await telegram_bot.send_message(
            chat_id=chat_id,
            text=text,
            parse_mode="MarkdownV2",
            reply_markup=reply_markup
        )
    except Exception as e:
        print(f"Failed to send message to chat_id {chat_id}: {e}")
    return None
