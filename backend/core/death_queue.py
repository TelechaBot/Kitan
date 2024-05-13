from typing import Optional

from loguru import logger
from pydantic import BaseModel

from core.cache import global_cache_runtime

QUEUE_DATA_KEY = "join_queue"


class JoinRequest(BaseModel):
    user_id: str
    chat_id: str
    message_id: str
    expired_at: str
    user_chat_id: int  # 5 MINUTES VALID
    language_code: Optional[str] = None


class JoinData(BaseModel):
    join_queue: list[JoinRequest]


class JoinManager:
    def __init__(self):
        self.cache = global_cache_runtime.get_client()

    async def read(self) -> JoinData:
        data = await self.cache.read_data(QUEUE_DATA_KEY)
        try:
            return JoinData.model_validate(data)
        except Exception as exc:
            logger.error(f"JoinManager.read: {exc}")
            return JoinData(join_queue=[])

    async def save(self, data: JoinData):
        await self.cache.set_data(QUEUE_DATA_KEY, data.model_dump_json())
        return True

    async def insert(self, join_request: JoinRequest):
        data = await self.read()
        data.join_queue.append(join_request)
        await self.save(data)
        return True


JOIN_MANAGER = JoinManager()
