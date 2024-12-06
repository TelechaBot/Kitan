from typing import Optional

from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class LuciKey(BaseSettings):
    luci_key: Optional[str] = Field(None, validation_alias="LUCI_KEY")

    @model_validator(mode="after")
    def validator(self):
        if self.luci_key is None:
            raise ValueError("RandomKey Not Set")
        return self

    @property
    def available(self):
        return self.luci_key is not None


load_dotenv()
LuciKey = LuciKey()
