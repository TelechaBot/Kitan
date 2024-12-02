from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()

img_path = 'ocr.png'
with open(img_path, 'rb') as f:
    img = f.read()
result, elapse = engine(img, use_det=False, use_cls=False, use_rec=True)
content = []
for item in result:
    print(item)
    if len(item) > 1:
        content.append(item[1])
print(''.join(content))

ad_text = "广告：有门槛，私我进群，私主号，更新群"
from cleanse_speech import DLFA
from cleanse_speech import SpamShelf

censor = DLFA(
    words_resource=[
        SpamShelf.CN.ADVERTISEMENT,
        ["有门槛", "私我进群", "私主号", "更新群"]
    ]
)

se = censor.extract_illegal_words(ad_text)
print(se)
