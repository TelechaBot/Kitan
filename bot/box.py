import telegramify_markdown

from common.const import EXPIRE_SHOW


def generate_verification_message(
        instructions,
        chat_title,
        user_name,
):
    """
    生成验证消息。
    """
    message_text = (
        f"# Hello, `{user_name}`.\n\n"
        f"You are requesting to join the group `{chat_title}`.\n"
        "But you need to prove that you are not a **robot**.\n"
        f"**You have {EXPIRE_SHOW}.**\n\n"
        f"*{instructions}*\n"
    )
    return telegramify_markdown.markdownify(message_text)


if __name__ == '__main__':
    print(
        generate_verification_message(
            "Please send me a message.",
            "Test Group",
            "Test User"
        )
    )
