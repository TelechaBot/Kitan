import pathlib
import re
from io import BytesIO
from typing import Optional

from cleanse_speech import DLFA
from cleanse_speech import SpamShelf
from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
# 本地 rule.txt 文件读取为BytesIO
rule_path = pathlib.Path(__file__).parent / "rule.txt"
if rule_path.exists():
    with open(rule_path, "rb") as f:
        RULE = BytesIO(f.read())
else:
    RULE = BytesIO(b"")

PRE_CHECKER = DLFA(words_resource=[
    ["有门槛", "私我进群", "私主号", "更新群", "https://t.me/+", "批发", "双绑号", "卡网", "进群"],
    SpamShelf.CN.ADVERTISEMENT,
])
CHAT_CHECKER = DLFA(words_resource=[
    [
        "有门槛",
        "私我进群",
        "私主号",
        "https://t.me/"
    ],
    RULE
])


def remove_special_chars(input_str):
    pattern = re.compile(r'[^\w]')  # 此正则表达式选取所有非字母、数字或下划线的字符
    intermediate_str = re.sub(pattern, '', input_str)  # 使用空字符替换所有匹配的字符
    cleaned_str = intermediate_str.replace('_', '')  # 我们还需要删除所有的下划线
    return cleaned_str


def flood_attack(text):
    if len(text) > 1200:
        return True
    return False


def judge_pre_join_text(text):
    return PRE_CHECKER.contains_illegal(text) or PRE_CHECKER.contains_illegal(remove_special_chars(text))


def judge_profile_photo(image: bytes):
    result, elapse = engine(image, use_det=False, use_cls=False, use_rec=True)
    content = []
    for item in result:
        if len(item) > 1:
            if isinstance(item[1], str):
                content.append(item[1])
    return judge_pre_join_text(''.join(content))


def judge_chat_text(text):
    # 是否是刷屏
    if flood_attack(text):
        return True
    return CHAT_CHECKER.contains_illegal(text) or CHAT_CHECKER.contains_illegal(remove_special_chars(text))


def reason_chat_text(text) -> Optional[str]:
    if flood_attack(text):
        return "FLOOD_ATTACK"
    if CHAT_CHECKER.contains_illegal(text):
        illegal = CHAT_CHECKER.extract_illegal_words(text)
        rule_text = ",".join(illegal[:5])
        return f"CHAT_ILLEGAL:{rule_text}"
    if CHAT_CHECKER.contains_illegal(remove_special_chars(text)):
        illegal = CHAT_CHECKER.extract_illegal_words(remove_special_chars(text))
        rule_text = ",".join(illegal[:5])
        return f"CHAT_ILLEGAL:{rule_text}"
    return None


def reason_chat_photo(image: bytes) -> Optional[str]:
    result, elapse = engine(image, use_det=False, use_cls=False, use_rec=True)
    content = []
    for item in result:
        if len(item) > 1:
            if isinstance(item[1], str):
                content.append(item[1])
    if PRE_CHECKER.contains_illegal(''.join(content)):
        illegal = PRE_CHECKER.extract_illegal_words(''.join(content))
        rule_text = ",".join(illegal[:5])
        return f"CHAT_ILLEGAL:{rule_text}"
    if PRE_CHECKER.contains_illegal(remove_special_chars(''.join(content))):
        illegal = PRE_CHECKER.extract_illegal_words(remove_special_chars(''.join(content)))
        rule_text = ",".join(illegal[:5])
        return f"CHAT_ILLEGAL:{rule_text}"
    return None


if __name__ == '__main__':
    print(judge_pre_join_text("私我进群"))
    # print(judge_profile_photo(open("test.jpg", "rb").read()))
    print(judge_chat_text("外挂"))
