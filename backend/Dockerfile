ARG PYTHON_BASE=3.10-slim

FROM python:$PYTHON_BASE AS builder

# 更新 pip 和安装 pdm
RUN pip install -U pip setuptools wheel && \
    pip install pdm

ENV PDM_CHECK_UPDATE=false

# 复制项目文件
COPY pyproject.toml pdm.lock /project/

WORKDIR /project

# 安装项目依赖
RUN pdm install --check --prod --no-editable

FROM python:$PYTHON_BASE

# 复制虚拟环境
COPY --from=builder /project/.venv /project/.venv
ENV PATH="/project/.venv/bin:$PATH"

# 复制项目文件
COPY . /project

WORKDIR /project

# 配置 Python 路径
ENV PYTHONPATH=/project
ENV DEBUG=false

RUN python -m pip list

# 暴露端口，默认值设置为 10100
EXPOSE ${SERVER_PORT:-10100}

# 启动命令
CMD ["python", "main.py"]

# 构建
# docker build -t kitan-backend .

# Run
# docker run -d -p 8000:8000 --name kitan-backend-container kitan-backend