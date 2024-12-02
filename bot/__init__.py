# -*- coding: utf-8 -*-
import asyncio
import time
from typing import Optional

import shortuuid
import telebot.async_telebot
import telegramify_markdown
from loguru import logger
from pydantic import SecretStr
from sqlmodel import select
from telebot import types, asyncio_filters
from telebot import util
from telebot.asyncio_helper import ApiTelegramException
from telebot.types import InlineKeyboardMarkup, WebAppInfo

from common.config.endpoint import EndpointSetting
from common.config.telegrambot import BOT, BotSetting
from common.const import EXPIRE_M_TIME, EXPIRE_SHOW
from common.database import dbInstance, VerifyRequest, JoinRequest
from common.middleware import globalGroupPolicy
from common.recall import globalResendManager, ResendEvnet
from common.safety.signature import generate_sign
from common.statistics import globalStatistics
from locales_config import get_locales
from service.judge import judge_pre_join_text, reason_chat_text, reason_chat_photo
from service.utils import parse_command


async def judgment(
        chat_id: int,
        target_string: str,
) -> Optional[str]:
    """
    处理群组配置，如果有问题则返回 True
    """
    policy = await globalGroupPolicy.read(group_id=str(chat_id))
    if policy.join_check:
        logger.debug(f"judgment:join-check:{chat_id}")
        if judge_pre_join_text(target_string):
            return policy.complaints_guide or "Please contact the administrator"
    return None


async def pre_process_user(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        chat_id: int,
        user_id: int,
        message_id: str,
        verify_url: str,
        preprocess_data: types.ChatFullInfo,
        addon_bio: Optional[str] = None
):
    """
    预处理用户的资料页
    :param telegram_bot: 机器人实例
    :param chat_id: 群组ID
    :param user_id: 用户ID
    :param message_id: 用户验证消息ID
    :param verify_url: 验证URL
    :param preprocess_data: 用户资料
    :param addon_bio: 附加的用户 BIO
    """
    # 读取待验证的群组策略
    policy = await globalGroupPolicy.read(group_id=str(chat_id))
    if policy.join_check:
        logger.debug(f"pre-process-user:join-check:{user_id}:{chat_id}")
        # 检查用户资料
        bio = addon_bio if addon_bio else preprocess_data.bio
        check_string = f"{preprocess_data.first_name} {preprocess_data.last_name} {bio}"
        if judge_pre_join_text(check_string):
            try:
                await telegram_bot.send_message(
                    chat_id=user_id,
                    text=telegramify_markdown.convert(
                        f"# Sorry, this group enabled join check.\n"
                        f"`You are recognized as a Advertiser or a Robot` by our risk control system.`\n\n"
                        f"**What should I do?**\n"
                        f"{policy.complaints_guide}",
                    ),
                    parse_mode="MarkdownV2",
                )
            except Exception as exc:
                logger.error(f"pre-process-user:send-message-failed:{user_id}:{chat_id}:{exc}")
            try:
                await telegram_bot.decline_chat_join_request(chat_id=chat_id, user_id=user_id)
            except Exception as exc:
                logger.error(f"pre-process-user:decline-failed:{user_id}:{chat_id}:{exc}")
            else:
                logger.info(f"pre-process-user:pre-check-not-pass:{user_id}:{chat_id}")
            # 删除死亡队列
            try:
                data = await globalJoinManager.read()
                removed = []
                for join_request in data.join_queue:
                    join_request: JoinRequest
                    if str(join_request.user_id) == str(user_id) and str(join_request.chat_id) == str(
                            chat_id):
                        removed.append(join_request)
                if removed:
                    for join_request in removed:
                        data.join_queue.remove(join_request)
                    await globalJoinManager.save(data)
                else:
                    logger.error(f"pre-process-user:not-found-dead-queue:{user_id}:{chat_id}")
            except Exception as exc:
                logger.error(f"pre-process-user:remove-join-queue-failed:{exc}")
            return logger.info(f"pre-process-user:join-check-failed:{user_id}:{chat_id}")
    # 发送验证按钮
    try:
        await telegram_bot.edit_message_reply_markup(
            chat_id=user_id,
            message_id=int(message_id),
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
            )
        )
    except Exception as exc:
        logger.error(f"Edit Message Failed {exc}")


async def download(telegram_bot: telebot.async_telebot.AsyncTeleBot, file):
    """
    下载文件
    :param telegram_bot: 机器人实例
    :param file: 文件
    """
    assert hasattr(file, "file_id"), "file_id not found"
    name = file.file_id
    _file_info = await telegram_bot.get_file(file.file_id)
    if isinstance(file, types.PhotoSize):
        name = f"{_file_info.file_unique_id}.jpg"
    if isinstance(file, types.Document):
        name = f"{file.file_unique_id} {file.file_name}"
    if not name.endswith(("jpg", "png", "webp")):
        return None
    downloaded_file = await telegram_bot.download_file(_file_info.file_path)
    return downloaded_file


async def dead_shot(
        user_id: str,
        chat_id: str,
        expired_m_at: int,
        language_code: str,
        user_chat_id: int,
        message_id: Optional[str] = None
):
    try:
        with dbInstance.get_session() as session:
            select_statement = select(JoinRequest).where(
                JoinRequest.user_id == user_id,
                JoinRequest.chat_id == chat_id
            )
            results = session.exec(select_statement)
            if results:
                for result in results:
                    session.delete(result)
                session.commit()
            dto = JoinRequest(
                user_id=str(user_id),
                chat_id=str(chat_id),
                expired_at=expired_m_at,
                language_code=str(language_code),
                user_chat_id=int(user_chat_id),
                message_id=str(message_id)
            )
            session.add(dto)
            session.commit()
    except Exception as exc:
        logger.error(f"dead-shot:failed-insert-join-queue:{user_id}:{chat_id}:{exc}")
    else:
        logger.success(f"dead-shot:success-insert-join-queue:{user_id}:{chat_id}")


async def handle_join_request(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.ChatJoinRequest
):
    """
    创建验证数据，并给用户发送验证信息
    """
    locale = get_locales(message.from_user.language_code)
    # 解析请求
    try:
        chat_title = message.chat.title[:20]
        user_name = message.from_user.full_name[:20]
        chat_id = str(message.chat.id)
        user_id = str(message.from_user.id)
        join_m_time = str(int(time.time() * 1000))  # 防止停机
        expired_m_at = int(join_m_time) + EXPIRE_M_TIME
    except Exception as exc:
        logger.exception(f"join-request:parse-failed:{exc} --data {message}")
        return False
    logger.info(
        f"join-request:start:{user_id}:{chat_id}"
        f" --user [{message.from_user.full_name}]"
        f" --chat [{message.chat.title}] @{message.chat.username}"
        f" --lang {message.from_user.language_code}"
        f" --bio {message.bio}"
    )
    # 尝试发送消息
    try:
        sent_message = await telegram_bot.send_message(
            message.user_chat_id,
            text=telegramify_markdown.convert(
                f"# Hello, `{user_name}`.\n\n"
                f"You are requesting to join the group `{chat_title}`.\n"
                "But you need to prove that you are not a **robot**.\n"
                f"**You have {EXPIRE_SHOW}.**\n\n"
                f"*{locale.verify_join}*\n"
                f"`{chat_id}-{user_id}-{expired_m_at}`",
            ),
            parse_mode="MarkdownV2",
        )
        sent_message_id = str(sent_message.message_id)
    except Exception as exc:
        sent_message_id = None
        logger.error(f"join-request:send-welcome-failed:{user_id}:{chat_id}:{exc}")
    # 投入死亡队列
    await dead_shot(
        user_id=user_id,
        chat_id=chat_id,
        expired_m_at=expired_m_at,
        language_code=message.from_user.language_code,
        user_chat_id=message.user_chat_id,
        message_id=sent_message_id
    )
    if not sent_message_id:
        return logger.error(f"join-request:user-refuse:{user_id}:{chat_id}")
    # 用户没有拉黑机器人，生产签名
    signature = generate_sign(
        chat_id=chat_id,
        message_id=str(sent_message_id),
        user_id=user_id,
        join_time=join_m_time,
        secret_key=SecretStr(BotSetting.token),
    )

    # 保存历史记录
    try:
        with dbInstance.get_session() as session:
            _request = VerifyRequest(user_id=user_id, chat_id=chat_id, timestamp=join_m_time, signature=signature)
            session.add(_request)
            session.commit()
    except Exception as exc:
        logger.error(f"join-request:save-history-failed:{user_id}:{chat_id}:{exc}")

    # 生产验证URL
    verify_url = f"https://{EndpointSetting.domain}/?chat_id={chat_id}&message_id={sent_message_id}&user_id={user_id}&timestamp={join_m_time}&signature={signature}"
    logger.info(f"join-request:gen-verify-url:{verify_url}")
    # 预先检查用户资料
    try:
        event = await telegram_bot.get_chat(message.from_user.id)
    except Exception as exc:
        logger.info(f"join-request:cant-get-user-profile:jump to fallback:{exc}")
        # 存储一份参数快照，并生成一个唯一数据命令+ID
        snapshot_uid = shortuuid.uuid()[0:6]
        verify_tip = f"**Copy `/verify {snapshot_uid}` then send me to continue verification of `{chat_title}`**"
        await globalResendManager.save(
            event_id=snapshot_uid,
            data=ResendEvnet(
                chat_id=str(chat_id),
                message_id=str(sent_message_id),
                verify_url=verify_url,
                user_id=str(user_id),
            )
        )
        # 发送一个提示，提示让用户使用 verify 命令
        try:
            await telegram_bot.send_message(
                chat_id=message.user_chat_id,
                text=telegramify_markdown.markdownify(verify_tip),
                parse_mode="MarkdownV2",
            )
        except Exception as exc:
            logger.error(f"join-request:send-verify-tip-failed:{user_id}:{chat_id}:{exc}")
    else:
        invalid = await judgment(
            chat_id=int(chat_id),
            target_string=f"{event.first_name} {event.last_name} {event.bio}"
        )
        if invalid:
            try:
                await telegram_bot.send_message(
                    chat_id=user_id,
                    text=telegramify_markdown.convert(
                        f"# Sorry, this group enabled join check.\n"
                        f"`You are recognized as a Advertiser or a Robot by our risk control system.`\n\n"
                        f"**What should I do?**\n"
                        f"{invalid}",
                    ),
                    parse_mode="MarkdownV2",
                )
            except Exception as exc:
                logger.error(f"pre-process-user:send-message-failed:{user_id}:{chat_id}:{exc}")
        await pre_process_user(
            telegram_bot=telegram_bot,
            chat_id=int(chat_id),
            user_id=int(user_id),
            message_id=sent_message_id,
            verify_url=verify_url,
            preprocess_data=event,
            addon_bio=message.bio
        )
    return True


async def handle_verify(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.Message
):
    """
    Verify Command
    注意确认用户的身份
    """
    locale = get_locales(message.from_user.language_code)
    chat_id, user_id = str(message.chat.id), str(message.from_user.id)
    logger.info(
        f"verify:start:{user_id}:{chat_id} --name [{message.from_user.full_name}] --lang {message.from_user.language_code}")
    # 解析命令
    try:
        command, event_id = parse_command(message.text)
        if not event_id:
            return logger.info(f"verify:command-parse-failed")
    except Exception as exc:
        return logger.info(f"verify:command-parse-failed:{exc}")
    event = await globalResendManager.read(event_id=event_id)
    if not event:
        return logger.info(f"verify:event-not-found:{event_id}")
    if str(event.user_id) != str(message.from_user.id):
        return logger.info(f"verify:event-user-not-match:{event.user_id}:{message.from_user.id}")
    # 尝试读取用户 BIO
    try:
        user = await telegram_bot.get_chat(message.from_user.id)
    except Exception as exc:
        return logger.error(f"verify:failed-fetch-user-profile:{exc}")
    # 预处理用户资料
    await pre_process_user(
        telegram_bot=telegram_bot,
        chat_id=event.chat_id,
        user_id=event.user_id,
        message_id=event.message_id,
        verify_url=event.verify_url,
        preprocess_data=user
    )


async def handle_join_check(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.Message
):
    """
    Join Check Command
    """
    locale = get_locales(message.from_user.language_code)
    chat_id, user_id = str(message.chat.id), str(message.from_user.id)
    logger.info(
        f"join_check:start:{user_id}:{chat_id} --name [{message.from_user.full_name}] --lang {message.from_user.language_code}")
    # 读取群组策略
    policy = await globalGroupPolicy.read(group_id=chat_id)
    # 切换开关
    policy.join_check = not policy.join_check
    # 保存策略
    await globalGroupPolicy.save(group_id=chat_id, data=policy)
    return await telegram_bot.send_message(
        message.chat.id,
        text=telegramify_markdown.convert(
            f"# Join Check: **{'Enabled' if policy.join_check else 'Disabled'}**\n"
            f"{locale.join_check_toggle}",
        ),
        parse_mode="MarkdownV2",
    )


async def handle_anti_spam(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.Message
):
    """
    Anti Spam Command
    """
    locale = get_locales(message.from_user.language_code)
    chat_id, user_id = str(message.chat.id), str(message.from_user.id)
    logger.info(
        f"anti_spam:start:{user_id}:{chat_id} --name [{message.from_user.full_name}] --lang {message.from_user.language_code}")
    # 读取群组策略
    policy = await globalGroupPolicy.read(group_id=chat_id)
    # 切换开关
    policy.anti_spam = not policy.anti_spam
    # 保存策略
    await globalGroupPolicy.save(group_id=chat_id, data=policy)
    return await telegram_bot.send_message(
        message.chat.id,
        text=telegramify_markdown.convert(
            f"# Anti Spam: **{'Enabled' if policy.anti_spam else 'Disabled'}**\n"
            f"{locale.anti_spam_toggle}",
        ),
        parse_mode="MarkdownV2",
    )


async def handle_complaints_guide(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.Message
):
    """
    Complaints Guide Command
    """
    locale = get_locales(message.from_user.language_code)
    chat_id, user_id = str(message.chat.id), str(message.from_user.id)
    logger.info(
        f"complaints_guide:start:{user_id}:{chat_id} --name [{message.from_user.full_name}] --lang {message.from_user.language_code}")
    # 读取群组策略
    policy = await globalGroupPolicy.read(group_id=chat_id)
    # 读取指引
    command, guide = parse_command(message.text)
    if not guide:
        return await telegram_bot.send_message(
            message.chat.id,
            text=telegramify_markdown.convert(
                f"# Complaints Guide: **Current**\n"
                f"{policy.complaints_guide}",
            ),
            parse_mode="MarkdownV2",
        )
    if len(guide) > 1000:
        return await telegram_bot.send_message(
            message.chat.id,
            text=telegramify_markdown.convert(
                f"# Complaints Guide: **Failed**\n"
                f"**The length of the guide is too long, please try again.**",
            ),
            parse_mode="MarkdownV2",
        )
    # 切换开关
    policy.complaints_guide = guide
    # 保存策略
    await globalGroupPolicy.save(group_id=str(message.chat.id), data=policy)
    return await telegram_bot.send_message(
        message.chat.id,
        text=telegramify_markdown.convert(
            f"# Complaints Guide: **Updated**\n"
            f"{locale.complaints_guide}",
        ),
        parse_mode="MarkdownV2",
    )


async def handle_group_msg_no_admin(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.Message
):
    """
    Group Message No Admin
    """
    # locale = get_locales(message.from_user.language_code)
    chat_id, user_id = str(message.chat.id), str(message.from_user.id)
    logger.trace(f"antispam:{user_id}:{chat_id} send a message")
    familiarity = await globalStatistics.increase(user_id=user_id, group_id=chat_id)
    if familiarity >= 8:
        # 不在检查范围内
        return "unfit for check"

    policy = await globalGroupPolicy.read(group_id=chat_id)
    if not policy.anti_spam:
        # 未启用反垃圾系统
        return "anti_spam disabled"

    check_string = f"{message.text}"
    reason = [
        reason_chat_text(check_string),
    ]
    if message.video:
        reason.append("INACTIVE_ACCOUNT_SEND_VIDEO")
    if message.video_note:
        reason.append("INACTIVE_ACCOUNT_SEND_VIDEO_NOTE")
    if message.voice:
        reason.append("INACTIVE_ACCOUNT_SEND_VOICE")
    if message.story:
        reason.append("INACTIVE_ACCOUNT_SEND_STORY")
    """
    if message.sticker:
        reason.append("INACTIVE_ACCOUNT_SEND_STICKER")
    """
    if message.photo:
        try:
            downloaded_file = await download(
                telegram_bot=telegram_bot,
                file=message.photo[-1]
            )
        except Exception as exc:
            logger.error(f"antispam:{user_id}:{chat_id}:{message.message_id} download photo failed {exc}")
        else:
            if downloaded_file:
                reason.append(reason_chat_photo(downloaded_file))
    if not any(reason):
        return "valid message"

    try:
        await telegram_bot.delete_message(chat_id=chat_id, message_id=message.message_id)
    except Exception as exc:
        logger.error(f"antispam:{user_id}:{chat_id}:{message.message_id} delete message failed {exc}")
    try:
        await telegram_bot.restrict_chat_member(
            chat_id=message.chat.id,
            user_id=message.from_user.id,
            permissions=types.ChatPermissions(
                can_send_messages=False,
                can_send_polls=False,
                can_send_audios=False,
                can_send_documents=False,
                can_send_photos=False,
                can_send_videos=False,
                can_send_video_notes=False,
                can_send_voice_notes=False,
                can_send_other_messages=False,
            ),
            until_date=int(time.time() + 60 * 3),
        )
    except Exception as exc:
        logger.error(f"antispam:{user_id}:{chat_id}:{message.message_id} restrict chat member failed {exc}")
    try:
        await telegram_bot.send_message(
            chat_id=message.chat.id,
            text=telegramify_markdown.convert(
                f"**Message from inactive user `{message.from_user.full_name}` is detected as spam,"
                f"so it has been deleted and muted for 3 minutes.**\n"
                f"Target Rule: `{','.join([item for item in reason if item])}`\n"
                f"*Please call admin in case of emergency.*",
            ),
            parse_mode="MarkdownV2",
        )
        await globalStatistics.reset(user_id=str(message.from_user.id), group_id=str(message.chat.id))
    except Exception as exc:
        logger.error(f"antispam:{user_id}:{chat_id}:{message.message_id} send message failed {exc}")
    return logger.info(f"antispam:{user_id}:{chat_id}:{message.message_id} is spam, reason: {reason}")


async def handle_start(
        telegram_bot: telebot.async_telebot.AsyncTeleBot,
        message: types.Message
):
    """
    Start Command
    """
    chat_id, user_id = str(message.chat.id), str(message.from_user.id)
    language_code = message.from_user.language_code
    locale = get_locales(language_code)
    logger.info(
        f"start:{user_id}:{chat_id} --name [{message.from_user.full_name}] --lang {message.from_user.language_code}"
    )
    # https://core.telegram.org/api/links#bot-links
    invite_link = (f"https://t.me/{BotSetting.bot_username}?startgroup"
                   f"&admin=can_invite_users+restrict_members+delete_messages")
    return await telegram_bot.send_message(
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


class Runner(object):
    def __init__(self, telegram_bot=BOT):
        self.telegram_bot = telegram_bot

    async def run(self):
        logger.info("Start Bot Runner")
        telegram_bot = self.telegram_bot

        @telegram_bot.chat_join_request_handler()
        async def join_request(message: types.ChatJoinRequest):
            """
            New Join Request
            """
            try:
                await handle_join_request(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"join-request:failed:{exc}")

        @telegram_bot.message_handler(
            commands="verify",
            chat_types=["private"]
        )
        async def verify(message: types.Message):
            """
            Verify Command
            注意确认用户的身份
            """
            try:
                await handle_verify(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"verify:failed:{exc}")

        @telegram_bot.message_handler(
            commands="join_check",
            chat_types=["group", "supergroup"],
            is_chat_admin=True
        )
        async def join_check(message: types.Message):
            """
            Join Check Command
            """
            try:
                await handle_join_check(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"join_check:failed:{exc}")

        @telegram_bot.message_handler(
            commands="anti_spam",
            chat_types=["group", "supergroup"],
            is_chat_admin=True
        )
        async def anti_spam(message: types.Message):
            """
            Anti Spam Command
            """
            try:
                await handle_anti_spam(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"anti_spam:failed:{exc}")

        @telegram_bot.message_handler(
            commands="complaints_guide",
            chat_types=["group", "supergroup"],
            is_chat_admin=True
        )
        async def complaints_guide(message: types.Message):
            """
            Complaints Guide Command
            """
            try:
                await handle_complaints_guide(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"complaints_guide:failed:{exc}")

        @telegram_bot.message_handler(
            chat_types=["group", "supergroup"],
            content_types=[
                "text",
                "audio",
                "document",
                # "animation",
                "photo",
                # "sticker",
                "video",
                "video_note",
                "voice",
                "story"
            ],
        )
        async def group_msg_no_admin(message: types.Message):
            """
            Group Message No Admin
            """
            try:
                await handle_group_msg_no_admin(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"antispam:failed:{exc}")

        @telegram_bot.message_handler(
            commands="start",
            chat_types=["private"]
        )
        async def start(message: types.Message):
            """
            Start Command
            """
            try:
                await handle_start(telegram_bot, message)
            except Exception as exc:
                logger.exception(f"start:failed:{exc}")

        telegram_bot.add_custom_filter(asyncio_filters.IsAdminFilter(telegram_bot))
        telegram_bot.add_custom_filter(asyncio_filters.ChatFilter())
        try:
            await telegram_bot.polling(
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
    logger.info("death-queue:execution-ground:start")
    while True:
        try:
            data = await globalJoinManager.read()
            expired = []
            for join_request in data.join_queue:
                if int(join_request.expired_at) < int(round(time.time() * 1000)):
                    expired.append(join_request)
            if expired:
                logger.info(f"decline:expired:processing --lens {len(expired)}")
            for join_request in expired:
                try:
                    # https://core.telegram.org/bots/api#chatjoinrequest
                    await BOT.send_message(
                        chat_id=join_request.user_chat_id,
                        text=telegramify_markdown.convert(get_locales(join_request.language_code).expired_join),
                        parse_mode="MarkdownV2",
                    )
                except Exception as exc:
                    if "initiate conversation" in str(exc):
                        logger.info(
                            f"decline:refuse:{join_request.user_id}:{join_request.chat_id}"
                        )
                    elif "blocked" in str(exc):
                        logger.info(
                            f"decline:user-blocked-bot:{join_request.user_id}:{join_request.chat_id}"
                        )
                    else:
                        logger.error(
                            f"decline:failed-send-message:{join_request.user_id}:{join_request.chat_id} chat-join-request because {exc}")
                try:
                    await BOT.delete_message(chat_id=join_request.user_id, message_id=join_request.message_id)
                except Exception as exc:
                    if "message to delete not found" in str(exc):
                        logger.info(
                            f"decline:delete-message-not-found:{join_request.user_id}:{join_request.chat_id}"
                        )
                    else:
                        logger.error(
                            f"decline:failed-del-join-message:{join_request.user_id}:{join_request.chat_id} chat-join-request because {exc}"
                        )
            for join_request in expired:
                try:
                    await BOT.decline_chat_join_request(chat_id=join_request.chat_id, user_id=join_request.user_id)
                    logger.info(f"decline:success:{join_request.user_id}:{join_request.chat_id} chat-join-request")
                except Exception as exc:
                    if "HIDE_REQUESTER_MISSING" in str(exc):
                        logger.info(f"decline:hide-requester-missing:{join_request.user_id}:{join_request.chat_id}")
                    else:
                        logger.error(
                            f"decline:failed-decline:{join_request.user_id}:{join_request.chat_id} chat-join-request because {exc}")
            data.join_queue = [join_request for join_request in data.join_queue if join_request not in expired]
            await globalJoinManager.save(data)
        except Exception as exc:
            logger.exception(f"detect:unknown-failed:{exc}")
        await asyncio.sleep(2)
