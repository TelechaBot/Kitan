# -*- coding: utf-8 -*-
import time

import telebot.async_telebot
import telegramify_markdown
from loguru import logger
from pydantic import SecretStr
from telebot import types
from telebot import util
from telebot.asyncio_helper import ApiTelegramException
from telebot.types import InlineKeyboardMarkup, WebAppInfo

from app_locales import get_locales
from setting.endpoint import EndpointSetting
from setting.telegrambot import BOT, BotSetting
from utils.signature import generate_sign


class BotRunner(object):
    def __init__(self, bot: telebot.async_telebot.AsyncTeleBot = BOT):
        self.bot = bot

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

        @bot.chat_join_request_handler()
        async def new_request(message: types.Message):
            """
            创建验证数据，并给用户发送验证信息
            """
            locale = get_locales(message.from_user.language_code)
            logger.info(
                f"Received a new join request from {message.from_user.id} in chat {message.chat.id} - {message.from_user.language_code}"
            )
            try:
                sent_message = await bot.send_message(
                    message.from_user.id,
                    text=telegramify_markdown.convert(locale.verify_join),
                    parse_mode="MarkdownV2",
                )
            except Exception as exc:
                logger.exception(f"User Refuse Message {exc}-{message.from_user.id}")
                return False
            message_id = str(sent_message.message_id)
            chat_id = str(message.chat.id)
            user_id = str(message.from_user.id)
            join_time = str(time.time() * 1000)
            signature = generate_sign(
                chat_id=chat_id,
                message_id=message_id,
                user_id=user_id,
                join_time=join_time,
                secret_key=SecretStr(BotSetting.token),
            )
            verify_url = f"https://{EndpointSetting.domain}/?chat_id={chat_id}&message_id={message_id}&user_id={user_id}&timestamp={join_time}&signature={signature}"
            logger.info(f"Verify URL: {verify_url}")
            await bot.edit_message_reply_markup(
                chat_id=sent_message.chat.id,
                message_id=sent_message.message_id,
                reply_markup=InlineKeyboardMarkup(
                    keyboard=[
                        [
                            types.InlineKeyboardButton(
                                text="Verify",
                                web_app=WebAppInfo(
                                    url=verify_url,
                                )
                            )
                        ]
                    ]
                ),
            )

        @bot.message_handler(
            commands="start", chat_types=["private"]
        )
        async def start(message: types.Message):
            """
            Start Command
            """
            locale = get_locales(message.from_user.language_code)
            logger.info(
                f"Received a new start command from {message.from_user.id} - {message.from_user.language_code}"
            )
            # https://core.telegram.org/api/links#bot-links
            invite_link = (f"https://t.me/{BotSetting.bot_username}?startgroup=start"
                           f"&admin=can_invite_users+restrict_members+delete_messages")
            return await bot.send_message(
                message.chat.id,
                text=telegramify_markdown.convert(locale.invite_group),
                parse_mode="MarkdownV2",
                reply_markup=InlineKeyboardMarkup(
                    keyboard=[
                        [
                            types.InlineKeyboardButton(
                                text="Invite me to your group",
                                url=invite_link,
                            )
                        ]
                    ]
                ),
            )

        try:
            await bot.polling(
                non_stop=True, allowed_updates=util.update_types, skip_pending=True
            )
        except ApiTelegramException as e:
            logger.opt(exception=e).exception("ApiTelegramException")
        except Exception as e:
            logger.exception(e)
