# /endpoint/verify 的服务器
# 用于验证用户的登录状态

import time
from enum import Enum

import telebot.util
from fastapi import FastAPI
from loguru import logger
from pydantic import BaseModel, SecretStr
from starlette.responses import JSONResponse

from const import EXPIRE_M_TIME
from core.mongo import MONGO_ENGINE
from core.mongo_odm import VerifyRequest
from setting.server import ServerSetting
from setting.telegrambot import BotSetting, BOT
from utils.signature import generate_sign

app = FastAPI()
TELEGRAM_BOT_TOKEN = BotSetting.token


class Source(BaseModel):
    chat_id: str
    message_id: str
    timestamp: str
    signature: str


class VerifyData(BaseModel):
    """
    响应数据
    """
    source: Source
    acc: dict
    signature: str
    web_app_data: str


class EnumStatu(Enum):
    success = "success"
    error = "error"


@app.get("/endpoints")
async def read_endpoints():
    # RockRoll The World
    return {"message": "open this page in IE6"}


@app.post("/endpoints/verify-captcha")
async def verify_captcha(query: VerifyData):
    # 获取可信数据
    web_app_data = telebot.util.parse_web_app_data(token=TELEGRAM_BOT_TOKEN, raw_init_data=query.web_app_data)

    if not web_app_data:
        logger.warning(f"Unsigned Request Received From {query.source}")
        return JSONResponse(
            status_code=400,
            content={"status": EnumStatu.error, "message": "INVALID_REQUEST"}
        )
    try:
        # 用户ID
        user_id = web_app_data['user']['id']
        # 验证的群组ID
        chat_id = query.source.chat_id
        # 机器人发送出去的消息ID
        message_id = query.source.message_id
        # 用户加入群组时间（我们机器人的签名时间）
        join_time = query.source.timestamp
        # 现在的时间...
        now_m_time = time.time() * 1000
    except KeyError:
        return JSONResponse(
            status_code=400,
            content={"status": EnumStatu.error, "message": "UNCOMPLETED_REQUEST"}
        )
    recover_sign = generate_sign(
        chat_id=chat_id,
        message_id=message_id,
        user_id=user_id,
        join_time=join_time,
        secret_key=SecretStr(BotSetting.token)
    )
    if recover_sign != query.signature:
        logger.error(f"Someone Try To Fake Request {query.source}")
        return JSONResponse(
            status_code=400,
            content={"status": EnumStatu.error, "message": "FAKE_REQUEST"}
        )
    # 会话过旧，虽然我们有死亡队列，但是这里还是要做一下判断，防止重放攻击
    if now_m_time - int(join_time) > EXPIRE_M_TIME:
        return JSONResponse(
            status_code=400,
            content={"status": EnumStatu.error, "message": "EXPIRED_REQUEST"}
        )
    logger.info(f"Router {query.source}")
    logger.info(f"User {query.acc}")
    logger.info(f"Parsed Data {web_app_data}")
    if not query.acc.get("verify_mode"):
        return JSONResponse(
            status_code=400,
            content={"status": EnumStatu.error, "message": "CAPTCHA_FAILED"}
        )
    # Success Accept User's Join Request
    try:
        history = await MONGO_ENGINE.find_one(VerifyRequest, VerifyRequest.signature == query.signature)
        if not history:
            logger.error(f"History Not Found {query.source}")
        history.passed = True
        await MONGO_ENGINE.save(history)
    except Exception as exc:
        logger.exception(f"Modify Request Failed when {exc}")
    try:
        await BOT.approve_chat_join_request(chat_id=chat_id, user_id=user_id)
        await BOT.delete_message(chat_id=user_id, message_id=message_id)
    except Exception as exc:
        logger.exception(f"Approve Request Failed {exc}")
    finally:
        # Accept user's join request
        return JSONResponse(
            status_code=204,
            content={"status": EnumStatu.success}
        )


async def run_server():
    import uvicorn
    host = ServerSetting.host
    port = ServerSetting.port
    logger.info(f"Server Start At {host}:{port}")
    uvicorn.run(app, host=host, port=port)
