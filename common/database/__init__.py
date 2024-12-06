import os
import uuid

from dotenv import load_dotenv
from loguru import logger
from sqlmodel import Field, Session, SQLModel, create_engine


class JoinRequest(SQLModel, table=True):
    """
    加入请求数据模型，用于存储用户的加入请求信息。
    包含用户 ID、聊天 ID、过期时间、用户聊天 ID、消息 ID 和语言代码。
    """
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    """
    唯一标识符
    """
    user_id: str = Field(index=True)
    """
    用户 ID
    """
    chat_id: str
    """
    群组聊天 ID
    """
    message_id: str | None = Field(default=None)
    """
    创建的消息 ID
    初次无法发送消息，所以可能是 None
    """
    user_chat_id: int  # 5 MINUTES VALID
    """
    加入请求的用户聊天 ID
    """
    expired_at: int | None = Field(default=None, index=True)
    language_code: str | None = Field(default=None)
    status: str = "waiting"
    solved: bool = False


class VerifyRequest(SQLModel, table=True):
    """
    验证请求数据模型，用于存储用户的验证请求信息。
    包含签名和来源信息，以及验证是否通过的标志。
    """
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: str
    chat_id: str
    timestamp: str
    signature: str = Field(index=True)
    passed: bool = False


class Database:
    """封装数据库连接和初始化逻辑，提供全局访问点。"""

    def __init__(self):
        """初始化 Database 实例，加载环境变量和设置数据库连接。"""
        load_dotenv()  # 加载 .env 文件中的环境变量

        self.postgresql_dsn = os.getenv(
            "POSTGRESQL_DSN", "postgresql://@localhost:5432/postgres"
        )
        try:
            self.engine = create_engine(self.postgresql_dsn, echo=True)
            self.create_all_tables()
            self._check_database_connection()
            logger.info("Database connection established successfully.")
        except Exception as e:
            logger.error(f"Failed to connect to the database: {e}")
            raise

    def _check_database_connection(self):
        """检查数据库连接是否可用。"""
        with self.engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")  # 执行基本 SQL 查询以验证连接是否成功

    def create_all_tables(self):
        """初始化数据库表结构（如果尚未创建）。"""
        logger.info("Creating database tables (if not exist)...")
        SQLModel.metadata.create_all(self.engine)

    def get_session(self) -> Session:
        """获取一个数据库会话 (Session)。"""
        return Session(self.engine)


# 初始化并创建全局 Database 实例
dbInstance = Database()
