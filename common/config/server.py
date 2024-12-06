from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class Server(BaseSettings):
    host: str = Field("127.0.0.1", validation_alias="SERVER_HOST")
    port: int = Field(10100, validation_alias="SERVER_PORT")
    cors_origin: str = Field("*", validation_alias="CORS_ORIGIN")

    @model_validator(mode="after")
    def validator(self):
        return self


load_dotenv()
ServerSetting = Server()
