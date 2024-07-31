ARG PYTHON_BASE=3.10-slim

FROM python:$PYTHON_BASE

# 更新 pip 和安装 pdm
RUN pip install -U pip setuptools wheel && \
    pip install pdm

ENV PDM_CHECK_UPDATE=false

# 复制项目文件
COPY pyproject.toml pdm.lock /project/

WORKDIR /project

# 安装项目依赖
RUN pdm install --prod

# 复制项目文件
COPY . /project

WORKDIR /project

# 配置 Python 路径
ENV PYTHONPATH=/project
ENV DEBUG=false
ENV PATH="/project/.venv/bin:$PATH"

# 暴露端口，默认值设置为 10100
EXPOSE ${SERVER_PORT:-10100}

# 启动命令
CMD ["pdm", "run", "python", "main.py"]

# 构建
# docker build -t kitan-backend .

# Run
# docker run -d -p 8000:8000 --name kitan-backend-container kitan-backend