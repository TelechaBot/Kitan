import asyncio
import textwrap

import instructor
from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic import Field

from common.config.oai import OpenaiSetting


class Polish(BaseModel):
    """
    将发生的事件转换为文学作品。发挥你的文学才能。
    尽可能让人阅读起来更加愉快。
    """
    message: str = Field(description='Message returned to the user')


extractor = instructor.from_openai(
    AsyncOpenAI(
        api_key=OpenaiSetting.openai_api_key,
        base_url=OpenaiSetting.openai_base_url
    )
)


async def organize(
        original_text: str,
        language: str = 'zh'
):
    """
    指示LLM重新组织文本。
    """
    ex_msg = await extractor.chat.completions.create(
        model="gpt-4o-mini",
        response_model=Polish,
        messages=[
            {"role": "system",
             "content": f"你是一个语言润色模组，需要将程序给出的信息转换为人类容易理解的信息。可以使用Markdown。Reply in {language} language."
             },
            {"role": "user", "content": original_text}
        ],
    )
    print(ex_msg.message)


if __name__ == '__main__':
    text1 = textwrap.dedent("""
# Hello, `河马`.

You are requesting to join the group `人均AV卡的AI调教群【先看置顶/频道】`.
But you need to prove that you are not a **robot**.
**You have 4 minutes.**
*您需要点击消息下方的按钮，在应用程序中完成验证。*
            """).strip()
    text2 = textwrap.dedent("""
    您的请求已经被拒绝。
    您没有通过我们的预先检查。
    
    您可以尝试呼叫管理员解释您的情况。
    
    您需要加入的群组已设置申诉方式：
    加入 群组 @avcard_appeal_bot 申诉。
    """).strip()
    asyncio.run(
        organize(
            text2
        )
    )
