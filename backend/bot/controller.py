# -*- coding: utf-8 -*-
import asyncio
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
from const import EXPIRE_M_TIME
from core.death_queue import JOIN_MANAGER, JoinRequest
from core.mongo import MONGO_ENGINE
from core.mongo_odm import VerifyRequest
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
            chat_title = message.chat.title[:10]
            user_name = message.from_user.username[:10]
            try:
                sent_message = await bot.send_message(
                    message.from_user.id,
                    text=telegramify_markdown.convert(
                        f"# Hello, {user_name}.\n\n"
                        f"You are requesting to join the group {chat_title}.\n"
                        "But you need to prove that you are not a robot.\n\n"
                        f"*{locale.verify_join}*"
                    ),
                    parse_mode="MarkdownV2",
                )
            except Exception as exc:
                logger.exception(f"User Refuse Message {exc}-{message.from_user.id}")
                return False
            message_id = str(sent_message.message_id)
            chat_id = str(message.chat.id)
            user_id = str(message.from_user.id)
            join_m_time = str(int(time.time() * 1000))
            expired_m_at = str(int(time.time() * 1000) + EXPIRE_M_TIME)
            signature = generate_sign(
                chat_id=chat_id,
                message_id=message_id,
                user_id=user_id,
                join_time=join_m_time,
                secret_key=SecretStr(BotSetting.token),
            )
            verify_url = f"https://{EndpointSetting.domain}/?chat_id={chat_id}&message_id={message_id}&user_id={user_id}&timestamp={join_m_time}&signature={signature}"
            logger.info(f"Verify URL: {verify_url}")
            try:
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
            except Exception as exc:
                logger.exception(f"Edit Message Failed {exc}")
            try:
                mongo_data = VerifyRequest(user_id=user_id, chat_id=chat_id, timestamp=join_m_time, signature=signature)
                await MONGO_ENGINE.save(mongo_data)
                logger.info(f"History Save Success for {user_id}")
            except Exception as exc:
                logger.exception(f"History Save Failed {exc}")
            try:
                # 投入死亡队列
                await JOIN_MANAGER.insert(
                    JoinRequest(
                        user_id=user_id,
                        chat_id=chat_id,
                        message_id=message_id,
                        expired_at=expired_m_at,
                        language_code=message.from_user.language_code,
                    )
                )
            except Exception as exc:
                logger.exception(f"Dead Queue Insert Failed {exc}")
            return True

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
            invite_link = (f"https://t.me/{BotSetting.bot_username}?startgroup"
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


async def execution_ground():
    """
    监听死亡队列，处理过期的验证请求
    """
    logger.info("Listen Dead Queue Start")
    while True:
        try:
            data = await JOIN_MANAGER.read()
            logger.info(f"Listen Dead Queue")
            expired = []
            for join_request in data.join_queue:
                if int(join_request.expired_at) < int(time.time() * 1000):
                    logger.info(f"Join Request Expired {join_request}")
                    expired.append(join_request)
            data.join_queue = [join_request for join_request in data.join_queue if join_request not in expired]
            try:
                for join_request in expired:
                    await BOT.decline_chat_join_request(chat_id=join_request.chat_id, user_id=join_request.user_id)
            except Exception as exc:
                logger.exception(f"Decline Chat Join Request Failed {exc}")
            try:
                for join_request in expired:
                    await BOT.send_message(
                        chat_id=join_request.user_id,
                        text=telegramify_markdown.convert(get_locales(join_request.language_code).expired_join),
                    )
                    await BOT.delete_message(chat_id=join_request.user_id, message_id=join_request.message_id)
            except Exception as exc:
                logger.exception(f"Delete Message Failed {exc}")
            finally:
                await JOIN_MANAGER.save(data)
        except Exception as exc:
            logger.exception(f"Listen Dead Queue Failed {exc}")
        await asyncio.sleep(5)
