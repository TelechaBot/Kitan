from odmantic import Model


class VerifyRequest(Model):
    user_id: str
    chat_id: str
    timestamp: str
    signature: str
    passed: bool = False
