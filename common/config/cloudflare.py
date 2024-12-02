from typing import Optional

from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class Cloudflare(BaseSettings):
    cloudflare_secret_key: Optional[str] = Field(None, validation_alias="CLOUDFLARE_SECRET_KEY")

    @model_validator(mode="after")
    def validator(self):
        return self

    @property
    def available(self):
        return self.cloudflare_secret_key is not None


load_dotenv()
CloudflareSetting = Cloudflare()
