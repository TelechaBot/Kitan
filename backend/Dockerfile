ARG PYTHON_BASE=3.10-slim

FROM python:$PYTHON_BASE AS builder

# 设定 PDM 的虚拟环境位置
ENV VENV_HOME=/project/.venv

RUN pip install -U pip setuptools wheel && \
    pip install pdm

ENV PDM_CHECK_UPDATE=false

COPY pyproject.toml pdm.lock /project/
WORKDIR /project
RUN pdm install --check --prod --no-editable

# 最终镜像
FROM python:$PYTHON_BASE

# 复制虚拟环境
COPY --from=builder /project/.venv /project/.venv

# 复制项目文件
COPY . /project

WORKDIR /project
# 配置 Python 路径
ENV PYTHONPATH=/project
ENV DEBUG=false
ENV PATH="/project/.venv/bin:$PATH"
# 暴露端口，默认值设置为 10100
EXPOSE ${SERVER_PORT:-10100}
RUN pip install -U pip setuptools wheel && \
    pip install pdm && \
    pdm add opencv-python-headless
# 启动命令
CMD ["pdm", "run", "python", "main.py"]