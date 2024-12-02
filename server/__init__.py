# /endpoint/verify 的服务器
# 用于验证用户的登录状态

import time
import uuid
from enum import Enum
from typing import Optional

import telebot.util
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pydantic import BaseModel, SecretStr, ConfigDict
from sqlmodel import select
from starlette.responses import JSONResponse

from common.config.cloudflare import CloudflareSetting
from common.config.server import ServerSetting
from common.config.telegrambot import BotSetting, BOT
from common.const import EXPIRE_M_TIME
from common.database import JoinRequest, VerifyRequest, dbInstance
from common.safety.signature import generate_sign, generate_oko
from server.validate_cloudflare import validate_cloudflare_turnstile

app = FastAPI()
if ServerSetting.cors_origin:
    origins = ServerSetting.cors_origin.split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

TELEGRAM_BOT_TOKEN = BotSetting.token


class Moon(BaseModel):
    chat_id: str
    message_id: str
    timestamp: str
    signature: str


class Device(BaseModel):
    device_id: str | None
    platform: str | None
    version: str
    mode: str
    ts: int
    model_config = ConfigDict(extra="allow")


class VerifyData(BaseModel):
    """
    响应数据
    """
    moon: Moon
    signature: str
    device: Device
    web_app_data: str
    ts: Optional[str] = None
    fingerprint: Optional[str] = None
    model_config = ConfigDict(extra="allow")


class CloudflareData(BaseModel):
    """
    Cloudflare 验证数据
    """
    moon: Moon
    turnstile_token: str
    web_app_data: str


class EnumStatu(Enum):
    success = "success"
    error = "error"


def build_content(message: str, code: int):
    return JSONResponse(
        status_code=code,
        content={"message": message}
    )


@app.get("/endpoints")
async def read_endpoints():
    # RockRoll The World
    return {"message": "open this page in IE6"}


@app.post("/endpoints/verify-cloudflare")
async def verify_cloudflare(data: CloudflareData):
    web_app_data = telebot.util.parse_web_app_data(token=TELEGRAM_BOT_TOKEN, raw_init_data=data.web_app_data)
    if not web_app_data:
        logger.error(f"verify-cloudflare:unsigned-request:{data}")
        return build_content("DISPUTE", 400)
    try:
        validated = validate_cloudflare_turnstile(
            turnstile_response=data.turnstile_token,
            cloudflare_secret_key=SecretStr(CloudflareSetting.cloudflare_secret_key)
        )
    except Exception as exc:
        logger.exception(f"verify-cloudflare:validate-cloudflare-turnstile:{exc}")
        return build_content("DISPUTE", 400)
    else:
        if not validated.success:
            logger.info(f"verify-cloudflare:cloudflare-failed:{data.moon} - {validated.error_codes}")
            return build_content("CLOUDFLARE_FAILED", 400)
        else:
            logger.info(f"verify-cloudflare:cloudflare-success:{data.moon}")
    return build_content("PASS", 200)


@app.post("/endpoints/verify-captcha")
async def verify_captcha(captcha_data: VerifyData):
    # 追踪请求
    event_id = f"E{uuid.uuid4().int & (1 << 24) - 1}"
    # 验证客户端消息
    web_app_data = telebot.util.parse_web_app_data(token=TELEGRAM_BOT_TOKEN, raw_init_data=captcha_data.web_app_data)
    if not web_app_data:
        logger.error(f"verify-captcha:unsigned-request:{event_id}:{captcha_data}")
        return build_content(f"ERROR {event_id}", 400)
    try:
        user_id = web_app_data['user']['id']
        chat_id = captcha_data.moon.chat_id
        message_id = captcha_data.moon.message_id
        # 加入群组时间
        join_time = captcha_data.moon.timestamp
        # 现在毫秒时间
        now_m_time = time.time() * 1000
    except KeyError:
        logger.error(f"verify-captcha:key-error:{event_id}:{captcha_data}")
        return build_content(f"ERROR {event_id}", 400)
    # 验证签发机构
    target_sign = generate_sign(
        user_id=user_id,
        chat_id=chat_id,
        message_id=message_id,
        join_time=join_time,
        secret_key=SecretStr(BotSetting.token)
    )
    t_s = generate_oko(data=captcha_data.web_app_data, time=captcha_data.ts)
    if target_sign != captcha_data.signature:
        logger.error(f"verify-captcha:fake-sign:{event_id}:{user_id}:{chat_id}:{captcha_data}")
        return build_content(f"ERROR {event_id}", 400)
    if not t_s:
        logger.error(f"verify-captcha:oko-failed:{event_id}:{user_id}:{chat_id}:{captcha_data}")
    else:
        logger.info(f"verify-captcha:oko-success:{event_id}:{user_id}:{chat_id}:{captcha_data.ts}")
    # 会话过旧，虽然我们有死亡队列，但是这里还是要做一下判断，防止重放攻击
    if now_m_time - int(join_time) > EXPIRE_M_TIME:
        return build_content("EXPIRED", 400)
    if not captcha_data.fingerprint:
        logger.error(f"verify-captcha:fingerprint-missing:{event_id}:{user_id}:{chat_id}")
        return build_content(f"ERROR {event_id}", 400)
    logger.info(f"verify-captcha:print-acc:{event_id}:{user_id}:{chat_id}:{captcha_data.moon}")
    logger.info(f"verify-captcha:print-webapp:{event_id}:{user_id}:{chat_id}:{web_app_data}")
    # Accept User's Join Request
    try:
        with dbInstance.get_session() as session:
            statement = select(JoinRequest).where(JoinRequest.user_id == user_id, JoinRequest.chat_id == chat_id)
            results = session.exec(statement)
            for result in results:
                session.delete(result)
            session.commit()
    except Exception as exc:
        logger.error(f"verify-captcha:opt-dead-queue-failed:{event_id}:{exc}")

    # Renew User's Join Request
    try:
        with dbInstance.get_session() as session:
            statement = select(VerifyRequest).where(VerifyRequest.signature == captcha_data.signature)
            requests = session.exec(statement)
            if not requests:
                logger.error(f"verify-captcha:history-not-found:{event_id}:{captcha_data.signature}")
            for request in requests:
                request.passed = True
                session.add(request)
            session.commit()
    except Exception as exc:
        logger.error(f"verify-captcha:opt-mongodb-failed:{exc} --signature {captcha_data.signature}")
    try:
        await BOT.approve_chat_join_request(chat_id=chat_id, user_id=user_id)
        await BOT.delete_message(chat_id=user_id, message_id=message_id)
    except Exception as exc:
        if "USER_ALREADY_PARTICIPANT" in str(exc):
            logger.info(f"verify-captcha:user-already-in-group:{user_id}:{chat_id}")
        elif "HIDE_REQUESTER_MISSING" in str(exc):
            logger.info(f"verify-captcha:hide-requester-missing:{user_id}:{chat_id}")
        else:
            logger.error(f"verify-captcha:approve-request-failed:{exc}")
    finally:
        # Accept user's join request
        return build_content("PASS", 202)


app.mount("/app", StaticFiles(directory="webapp/dist"), name="webapp")
