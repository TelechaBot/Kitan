# -*- coding: utf-8 -*-
from loguru import logger
from telebot import types
from telebot import util
from telebot.async_telebot import AsyncTeleBot
from telebot.asyncio_helper import ApiTelegramException
from telebot.asyncio_storage import StateMemoryStorage

from setting.telegrambot import BotSetting

StepCache = StateMemoryStorage()


class BotRunner(object):
    def __init__(self):
        self.bot = AsyncTeleBot(BotSetting.token, state_storage=StepCache)

    async def download(self, file):
        assert hasattr(file, "file_id"), "file_id not found"
        name = file.file_id
        _file_info = await self.bot.get_file(file.file_id)
        if isinstance(file, types.PhotoSize):
            name = f"{_file_info.file_unique_id}.jpg"
        if isinstance(file, types.Document):
            name = f"{file.file_unique_id} {file.file_name}"
        if not name.endswith(("jpg", "png", "webp")):
            return None
        downloaded_file = await self.bot.download_file(_file_info.file_path)
        return downloaded_file

    async def run(self):
        logger.info("Bot Start")
        bot = self.bot
        if BotSetting.proxy_address:
            from telebot import asyncio_helper

            asyncio_helper.proxy = BotSetting.proxy_address
            logger.info("Proxy tunnels are being used!")

        @bot.chat_join_request_handler()
        async def new_request(message):
            """
            创建验证数据，并给用户发送验证信息
            """
            return await bot.reply_to(
                message, text="Welcome to join us!", parse_mode="MarkdownV2"
            )

        @bot.message_handler(
            commands="sfw", chat_types=["supergroup", "group", "private"]
        )
        async def sfw(message: types.Message):
            return await bot.reply_to(message, text="111", parse_mode="MarkdownV2")

        try:
            await bot.polling(
                non_stop=True, allowed_updates=util.update_types, skip_pending=True
            )
        except ApiTelegramException as e:
            logger.opt(exception=e).exception("ApiTelegramException")
        except Exception as e:
            logger.exception(e)
