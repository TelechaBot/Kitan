ARG PYTHON_BASE=3.10-slim

FROM python:$PYTHON_BASE AS builder

RUN pip install -U pip setuptools wheel && \
    pip install pdm

ENV PDM_CHECK_UPDATE=false

COPY pyproject.toml pdm.lock /project/

WORKDIR /project
RUN pdm install --check --prod --no-editable

FROM python:$PYTHON_BASE

COPY --from=builder /project/.venv /project/.venv
ENV PATH="/project/.venv/bin:$PATH"

COPY . /project
WORKDIR /project

ENV PYTHONPATH=/project
ENV DEBUG=false

# 变量，用于设置服务器端口，可以被环境变量 SERVER_PORT 覆盖
EXPOSE ${SERVER_PORT:-10100}

CMD ["python", "main.py"]


# 构建
# docker build -t kitan-backend .

# Run
# docker run -d -p 8000:8000 --name kitan-backend-container kitan-backend