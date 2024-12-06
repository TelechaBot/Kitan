from typing import Optional

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings


class Openai(BaseSettings):
    openai_api_key: Optional[str] = Field(None, validation_alias="OPENAI_API_KEY")
    openai_base_url: Optional[str] = Field(None, validation_alias="OPENAI_BASE_URL")

    @property
    def available(self):
        return self.openai_api_key is not None and self.openai_base_url is not None


load_dotenv()
OpenaiSetting = Openai()
