"""
用户行为记录系统
分辨是否是用户是否是群组高频发言者。
"""
from loguru import logger

from core.cache import global_cache_runtime

AREA = "counter"
TIMEOUT = 60 * 60 * 24 * 5  # 5 days


class Statistics(object):
    def __init__(self):
        self.cache = global_cache_runtime.get_client()

    @staticmethod
    def prefix(user_id: str, group_id: str) -> str:
        return f"{AREA}:{user_id}_{group_id}"

    async def increase(self, user_id: str, group_id: str) -> int:
        now_count = await self.cache.read_data(self.prefix(user_id, group_id))
        # 如果是 bytes 类型，转换为字符串
        if isinstance(now_count, bytes):
            now_count = now_count.decode('utf-8')
        try:
            # 尝试转换为整数
            now_count = int(now_count)
        except Exception as exc:
            logger.trace(f"Statistics.increase: {exc}")
            now_count = 0
        new_count = now_count + 1
        await self.cache.set_data(self.prefix(user_id, group_id), str(new_count), timeout=TIMEOUT)
        return now_count


STATISTICS = Statistics()
