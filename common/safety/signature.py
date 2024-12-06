import hashlib
import hmac

from pydantic import SecretStr


def generate_sign(
        message_id: str,
        chat_id: str,
        user_id: str,
        join_time: str,
        secret_key: SecretStr
) -> str:
    sign_value = f"{message_id}={chat_id}={user_id}={join_time}"
    secret_key = secret_key.get_secret_value().encode()
    sign = hmac.new(secret_key, sign_value.encode(), digestmod=hashlib.sha256).hexdigest()
    return sign


def generate_oko(data: str, time: str) -> bool:
    if not time:
        return False
    return int(time) % (hashlib.sha256(data.encode()).hexdigest().count("0") + 1) == 0


if __name__ == '__main__':
    print(generate_sign("1", "2", "3", "4", SecretStr("test")))
