from typing import Optional

from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class Endpoint(BaseSettings):
    domain: Optional[str] = Field(None, validation_alias="VERIFY_DOMAIN")

    @model_validator(mode="after")
    def validator(self):
        if self.domain is None:
            raise ValueError("Endpoint Not Set")
        return self

    @property
    def available(self):
        return self.domain is not None


load_dotenv()
EndpointSetting = Endpoint()
