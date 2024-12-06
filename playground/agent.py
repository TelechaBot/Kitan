from dataclasses import dataclass

from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIModel

from common.config.oai import OpenaiSetting


@dataclass
class JoinRequestDependencies:
    user_name: str
    user_id: int
    chat_id: int
    chat_title: str
    language: str = 'en'


class MessageResult(BaseModel):
    message: str = Field(description='Message returned to the telegram account')
    risk: int = Field(description='Risk level of query', ge=0, le=10)


verify_agent = Agent(
    OpenAIModel(
        model_name='gpt-4o-mini',
        openai_client=AsyncOpenAI(
            api_key=OpenaiSetting.openai_api_key,
            base_url=OpenaiSetting.openai_base_url),
    ),
    deps_type=JoinRequestDependencies,
    result_type=MessageResult,
    system_prompt=(
        '你是Telegram验证系统的守门人，你需要验证用户是真实的合法的人类，而不是机器人。'
    ),
)


@verify_agent.system_prompt
async def basic_bio(ctx: RunContext[JoinRequestDependencies]) -> str:
    return (f"Telegram Account [{ctx.deps.user_name}](tg://user?id={ctx.deps.user_id}) "
            f"want to join the group [{ctx.deps.chat_title}](tg://chat?id={ctx.deps.chat_id}). Using language: {ctx.deps.language}.")


@verify_agent.tool
async def refuse_user(
        ctx: RunContext[JoinRequestDependencies], report: str
) -> str:
    """Refuse the user to join the group"""
    print(
        f"Refuse user {ctx.deps.user_name}({ctx.deps.user_id}) to join the group {ctx.deps.chat_title}({ctx.deps.chat_id}).")
    return f'OK, USER_REFUSED'


@verify_agent.tool
async def send_verify(
        ctx: RunContext[JoinRequestDependencies], report: str
) -> str:
    """Block the user to join the group"""
    url = f"https://t.me/{ctx.deps.chat_title}?start={report}"
    print(
        f"Send verify url to user {ctx.deps.user_name}({ctx.deps.user_id}) to join the group {ctx.deps.chat_title}({ctx.deps.chat_id})."
    )
    return f'OK, Already Send Verify Url: {url}'


if __name__ == '__main__':
    deps = JoinRequestDependencies(
        chat_id=123,
        chat_title='Test Group',
        user_id=456,
        user_name='Real Man'
    )
    result = verify_agent.run_sync("System Require Verify", deps=deps)
    print(result.data)
    memory = result.all_messages()
    while True:
        text = input('Input: ')
        if text == 'exit':
            break
        result = verify_agent.run_sync(text, deps=deps, message_history=memory)
        print(result.data)
        memory = result.all_messages()
