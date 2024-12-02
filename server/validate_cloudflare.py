import httpx
import pydantic
from pydantic import BaseModel, Field


class ConfigureError(Exception):
    pass


class CloudflareError(Exception):
    pass


class SiteVerifyRequest(BaseModel):
    secret: str
    response: str


class SiteVerifyResponse(BaseModel):
    success: bool
    error_codes: list[str] = Field(default_factory=list)


def validate_cloudflare_turnstile(
        turnstile_response: str,
        cloudflare_secret_key: pydantic.SecretStr
) -> SiteVerifyResponse:
    if not cloudflare_secret_key:
        raise ConfigureError("You must provide a secret key.")
    if not turnstile_response:
        raise ConfigureError("You must provide a response from the turnstile challenge.")
    CF_TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
    request_data = SiteVerifyRequest(secret=cloudflare_secret_key.get_secret_value(), response=turnstile_response)
    try:
        httpx_client = httpx.Client()
        with httpx_client as client:
            resp = client.post(
                CF_TURNSTILE,
                json=request_data.model_dump(mode="json")
            )
        resp.raise_for_status()
        site_response = SiteVerifyResponse.model_validate(resp.json())
        return site_response
    except Exception as x:
        raise CloudflareError(f"Failed to validate turnstile response: {x}")


request_example = {
    "secret": "0x5ABAAFAAAn72S0000000000000P6zooFZt",
    "response": "???",
}

success_example = {
    "success": True,
    "challenge_ts": "2022-02-28T15:14:30.096Z",
    "hostname": "example.com",
    "error-codes": [],
    "action": "login",
    "cdata": "session_id-123456789"
}

failure_example = {
    "success": False,
    "hostname": "",
    "error-codes": [
        "invalid-input-response"
    ]
}
