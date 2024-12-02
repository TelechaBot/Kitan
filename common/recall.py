from typing import Optional

from loguru import logger
from pydantic import BaseModel

from common.cache import global_cache_runtime

AREA = "recall"
TIMEOUT = 60 * 5


class ResendEvnet(BaseModel):
    chat_id: str
    user_id: str
    message_id: str
    verify_url: str


class ResendManager:
    def __init__(self):
        self.cache = global_cache_runtime.get_client()

    @staticmethod
    def prefix(key: str) -> str:
        return f"{AREA}:{key}"

    async def read(self, event_id: str) -> Optional[ResendEvnet]:
        data = await self.cache.read_data(self.prefix(event_id))
        try:
            return ResendEvnet.model_validate(data)
        except Exception as exc:
            logger.error(f"ResendManager.read: {exc}")
            return None

    async def save(self, event_id: str, data: ResendEvnet):
        await self.cache.set_data(self.prefix(event_id), data.model_dump_json(), timeout=TIMEOUT)
        return True


globalResendManager = ResendManager()
