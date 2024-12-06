"""
检查用户
"""
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

from common.cache import global_cache_runtime

AREA = "configure"

"""
活跃检查阈值
预检正则列表
群组消息正则列表
允许的语言地区
"""


class GroupConfig(BaseModel):
    active_threshold: int = Field(default=7, description="活跃检查阈值")
    """Active Threshold"""
    ban_words: list[str] = Field(default=list, description="违禁词列表")
    """Ban Words"""
    pre_check_regex: list[str] = Field(default=list, description="预检正则列表")
    """Pre Check Regex"""
    skip_message_type: list[str] = Field(default=list, description="跳过消息类型")
    """不会被检查的消息类型"""
    ban_language: list[str] = Field(default=list, description="被禁止的语言地区")
    """Ban Language"""
    model_config = ConfigDict(extra="ignore")


class GroupConfigManager:
    def __init__(self):
        self.cache = global_cache_runtime.get_client()

    @staticmethod
    def prefix(key: str) -> str:
        return f"{AREA}:{key}"

    async def read(self, chat_id: str) -> GroupConfig:
        data = await self.cache.read_data(self.prefix(chat_id))
        try:
            return GroupConfig.model_validate(data)
        except Exception as exc:
            logger.debug(f"PolicyManager.read: {exc}")
            return GroupConfig()

    async def save(self, chat_id: str, data: GroupConfig):
        await self.cache.set_data(self.prefix(chat_id), data.model_dump_json())
        return True


globalGroupConfig = GroupConfigManager()
