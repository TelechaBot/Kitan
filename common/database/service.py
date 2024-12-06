from typing import List

from loguru import logger
from sqlmodel import select

from common.database import Database
from common.database import JoinRequest, VerifyRequest


class DatabaseService:
    def __init__(self, db_instance: 'Database'):
        self.db_instance = db_instance

    def save_join_request(
            self,
            user_id: str,
            chat_id: str,
            expired_m_at: int,
            language_code: str,
            user_chat_id: int,
            message_id: str | None
    ):
        """
        插入加入请求到数据库中。
        :param user_id: 用户 ID
        :param chat_id: 聊天 ID
        :param expired_m_at: 过期时间
        :param language_code: 语言代码
        :param user_chat_id: 用户聊天 ID
        :param message_id: 消息 ID
        """
        try:
            with self.db_instance.get_session() as session:
                select_statement = select(JoinRequest).where(
                    JoinRequest.user_id == user_id,
                    JoinRequest.chat_id == chat_id,
                    JoinRequest.solved == False
                )
                results = session.exec(select_statement)
                if not results:
                    dto = JoinRequest(
                        user_id=str(user_id),
                        chat_id=str(chat_id),
                        expired_at=expired_m_at,
                        language_code=str(language_code),
                        user_chat_id=int(user_chat_id),
                        message_id=message_id
                    )
                    session.add(dto)
                session.commit()
        except Exception as exc:
            logger.error(f"insert_join_request:failed-insert-join-queue:{user_id}:{chat_id}:{exc}")
        else:
            logger.success(f"insert_join_request:success-insert-join-queue:{user_id}:{chat_id}")

    def add_verify_request(
            self,
            user_id: str,
            chat_id: str,
            timestamp: str,
            signature: str
    ):
        """
        保存验证请求到数据库中。
        :param user_id: 用户 ID
        :param chat_id: 聊天 ID
        :param timestamp: 时间戳
        :param signature: 签名
        """
        try:
            with self.db_instance.get_session() as session:
                _request = VerifyRequest(user_id=user_id, chat_id=chat_id, timestamp=timestamp, signature=signature)
                session.add(_request)
                session.commit()
        except Exception as exc:
            logger.error(f"save_verify_request:save-history-failed:{user_id}:{chat_id}:{exc}")

    def fetch_pending_join_request(
            self,
            timer: int
    ) -> List[JoinRequest]:
        """
        获取需要解决的加入请求。
        :param timer: 当前时间戳
        :return: 需要解决的加入请求列表
        """
        try:
            with self.db_instance.get_session() as session:
                select_statement = select(JoinRequest).where(
                    JoinRequest.solved == False,
                    JoinRequest.expired_at <= timer
                )
                results = session.exec(select_statement).all()
                return results
        except Exception as exc:
            logger.error(f"get_join_requests:failed-fetch-join-requests:{exc}")
            return []

    def solve_join_request(
            self,
            join_requests: List[JoinRequest],
    ):
        """
        标记加入请求为已解决。
        :param join_requests: 需要标记为已解决的加入请求列表
        """
        try:
            with self.db_instance.get_session() as session:
                for join_request in join_requests:
                    join_request.solved = True
                    session.add(join_request)
                session.commit()
        except Exception as exc:
            logger.error(
                f"delete_join_request:failed-database:{join_requests}:{exc}"
            )
