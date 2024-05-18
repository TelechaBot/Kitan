from const import EXPIRE_SHOW


class BaseLocales(object):
    verify_join = f"Click the button below to prove you are not a robot, it will be expired in {EXPIRE_SHOW}. If you think its too difficult, you can try use mobile app."
    invite_group = "Invite me to your group"
    expired_join = "Your join request is expired, so i rejected it."
    join_check_toggle = "Now i will check new members' bio for ads and promotions. You can add extra appeal guide to prevent false positives."
    anti_spam_toggle = "Now i will check new messages for spam and ads, i will just delete them and mute for 2 minutes."

    @classmethod
    def get(cls, key):
        return getattr(cls, key, None)


class EnLocales(BaseLocales):
    verify_join = f"Click the button below to prove you are not a robot, it will be expired in {EXPIRE_SHOW}. If you think its too difficult, you can try use mobile app."
    invite_group = "You can invite me to your group by clicking the button below, btw i need some permissions to work properly."
    expired_join = "Your join request is expired, so i rejected it."
    join_check_toggle = "Now i will check new members' bio for ads and promotions. You can add extra appeal guide to prevent false positives."
    anti_spam_toggle = "Now i will check new messages for spam and ads, i will just delete them and mute for 2 minutes."


class ZhLocales(BaseLocales):
    verify_join = f"点击下方按钮证明你不是机器人，否则 {EXPIRE_SHOW} 后您的加入请求会被自动拒绝。如果你认为验证太难，可以在 Telegram APP 一键验证。"
    invite_group = "你可以通过点击下方按钮邀请我加入你的群组，顺便我需要一些权限才能正常工作。"
    expired_join = "您的加入请求已经过期，所以我拒绝了它。"
    join_check_toggle = "现在我会检查新成员的简介是否包含广告和推广内容。您可以额外添加申诉指引防范误判。"
    anti_spam_toggle = "现在我会检查新消息是否包含冒犯内容，我会删除它们并禁言 2 分钟。"


def get_locales(language):
    return {
        "en-US": EnLocales,
        "zh-Hans": ZhLocales,
    }.get(language, EnLocales)
