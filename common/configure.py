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


class PolicyRule(BaseModel):
    active_message: bool = Field(default=False, description="检查加入成员的简历是否包含广告")
    """Join Check"""
    regex_check: bool = Field(default=False, description="反骚扰反侮辱反刷屏")
    """Anti Spam"""
    complaints_guide: str = Field(
        default="*There is no appeal channel set up for this group, please contact the administrator to join in.*",
        description="Used to direct users where to make appeals"
    )
    """Complaints Guide"""
    model_config = ConfigDict(extra="ignore")


class PolicyManager:
    def __init__(self):
        self.cache = global_cache_runtime.get_client()

    @staticmethod
    def prefix(key: str) -> str:
        return f"{AREA}:{key}"

    async def read(self, group_id: str) -> PolicyRule:
        data = await self.cache.read_data(self.prefix(group_id))
        try:
            return PolicyRule.model_validate(data)
        except Exception as exc:
            logger.debug(f"PolicyManager.read: {exc}")
            return PolicyRule()

    async def save(self, group_id: str, data: PolicyRule):
        await self.cache.set_data(self.prefix(group_id), data.model_dump_json())
        return True


globalGroupPolicy = PolicyManager()
