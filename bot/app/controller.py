# -*- coding: utf-8 -*-
# @Time    : 2023/11/18 上午12:18
# @File    : controller.py
# @Software: PyCharm
from io import BytesIO

from PIL import Image
from asgiref.sync import sync_to_async
from loguru import logger
from novelai_python.tool.random_prompt import RandomPromptGenerator
from novelai_python.tool.image_metadata import ImageMetadata
from telebot import formatting
from telebot import types
from telebot import util
from telebot.async_telebot import AsyncTeleBot
from telebot.asyncio_helper import ApiTelegramException
from telebot.asyncio_storage import StateMemoryStorage
import telegramify_markdown
from app.event import pipeline_tag
from app_conf import settings
from setting.telegrambot import BotSetting

StepCache = StateMemoryStorage()


@sync_to_async
def sync_to_async_func():
    pass


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

    async def tagger(self, file) -> str:
        raw_file_data = await self.download(file=file)
        if raw_file_data is None:
            return "🥛 Not An image"
        if isinstance(raw_file_data, bytes):
            file_data = BytesIO(raw_file_data)
        else:
            file_data = raw_file_data
        result = await pipeline_tag(trace_id="test", content=file_data)
        content = [
            f"**🥽 AnimeScore: {result.anime_score}**",
            f"**🔍 Infer Tags**: ```\n{result.anime_tags}```",
        ]
        try:
            file_data.seek(0)
            meta_data = ImageMetadata.load_image(file_data)
            read_prompt = meta_data.Description
            read_model = meta_data.used_model

            rq_type = meta_data.Comment.request_type
            mode = ""
            if rq_type == "PromptGenerateRequest":
                mode += "Text2Image"
            elif rq_type == "Img2ImgRequest":
                mode += "Img2Img"
            if meta_data.Comment.reference_strength:
                mode += "+VibeTransfer"
            try:
                file_data.seek(0)
                is_novelai = meta_data.verify_image_is_novelai(Image.open(file_data))
            except Exception:
                is_novelai = False
        except Exception as e:
            logger.exception(e)
        else:
            content.append(f"**✏ NovelAI Prompt:** ```{read_prompt}```")
            if read_model:
                content.append(f"**📦 Model:** `{read_model.value}`")
            if meta_data.Source:
                content.append(f"**📦 Source:** `{meta_data.Source}`")
            if not is_novelai:
                content.append("**🧊 Not Signed by NovelAI**")
            content.append(f"**✏ Mode**: `{mode}`")
        if result.characters:
            content.append(f"**🌟 Characters:** `{','.join(result.characters)}`")
        prompt = telegramify_markdown.convert("\n".join(content))
        file_data.close()
        return prompt

    async def run(self):
        logger.info("Bot Start")
        bot = self.bot
        if BotSetting.proxy_address:
            from telebot import asyncio_helper

            asyncio_helper.proxy = BotSetting.proxy_address
            logger.info("Proxy tunnels are being used!")

        @bot.message_handler(
            content_types=["photo", "document"], chat_types=["private"]
        )
        async def start(message: types.Message):
            if settings.mode.only_white:
                if message.chat.id not in settings.mode.white_group:
                    return logger.info(f"White List Out {message.chat.id}")
            logger.info(f"Report in {message.chat.id} {message.from_user.id}")
            if message.photo:
                prompt = await self.tagger(file=message.photo[-1])
                await bot.reply_to(message, text=prompt, parse_mode="MarkdownV2")
            if message.document:
                prompt = await self.tagger(file=message.document)
                await bot.reply_to(message, text=prompt, parse_mode="MarkdownV2")

        @bot.message_handler(
            commands="nsfw", chat_types=["supergroup", "group", "private"]
        )
        async def nsfw(message: types.Message):
            if settings.mode.only_white:
                if message.chat.id not in settings.mode.white_group:
                    return logger.info(f"White List Out {message.chat.id}")
            contents = RandomPromptGenerator(nsfw_enabled=True).generate()
            prompt = formatting.format_text(
                formatting.mbold("🥛 NSFW Prompt"), formatting.mcode(content=contents)
            )
            return await bot.reply_to(message, text=prompt, parse_mode="MarkdownV2")

        @bot.message_handler(
            commands="sfw", chat_types=["supergroup", "group", "private"]
        )
        async def sfw(message: types.Message):
            if settings.mode.only_white:
                if message.chat.id not in settings.mode.white_group:
                    return logger.info(f"White List Out {message.chat.id}")
            contents = RandomPromptGenerator(nsfw_enabled=False).generate()
            prompt = formatting.format_text(
                formatting.mbold("🥛 SFW Prompt"), formatting.mcode(content=contents)
            )
            return await bot.reply_to(message, text=prompt, parse_mode="MarkdownV2")

        @bot.message_handler(commands="tag", chat_types=["supergroup", "group"])
        async def tag(message: types.Message):
            if settings.mode.only_white:
                if message.chat.id not in settings.mode.white_group:
                    return logger.info(f"White List Out {message.chat.id}")

            if not message.reply_to_message:
                return await bot.reply_to(
                    message,
                    text=f"🍡 please reply to message with this command ({message.chat.id})",
                )
            logger.info(f"Report in {message.chat.id} {message.from_user.id}")
            reply_message = message.reply_to_message
            reply_message_ph = reply_message.photo
            reply_message_doc = reply_message.document
            if reply_message_ph:
                prompt = await self.tagger(file=reply_message_ph[-1])
                return await bot.reply_to(message, text=prompt, parse_mode="MarkdownV2")
            if reply_message_doc:
                prompt = await self.tagger(file=reply_message_doc)
                return await bot.reply_to(message, text=prompt, parse_mode="MarkdownV2")
            return await bot.reply_to(message, text="🥛 Not image")

        try:
            await bot.polling(
                non_stop=True, allowed_updates=util.update_types, skip_pending=True
            )
        except ApiTelegramException as e:
            logger.opt(exception=e).exception("ApiTelegramException")
        except Exception as e:
            logger.exception(e)
