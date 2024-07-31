# 使用 Node.js 18 作为基础镜像
FROM node:18 AS build

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制项目文件
COPY . .

# 设置环境变量
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

# 构建项目
RUN npm run build

# 使用轻量级 Node.js 运行时镜像
FROM node:18-alpine

# 从构建阶段复制构建好的资产
COPY --from=build /app/dist /app/dist

# 设置工作目录
WORKDIR /app

# 全局安装 http-server 包，用于提供静态文件
RUN npm install -g http-server && apk --no-cache add tini

# 暴露服务端口（不会占用宿主机的 80 和 443 端口）
EXPOSE 8080
EXPOSE 8443

# 启动命令，检查证书文件是否存在
CMD if [ "$HTTPS_ENABLED" = "true" ] && [ -f /etc/ssl/server.crt ] && [ -f /etc/ssl/server.key ]; then \
      tini -- http-server dist -p 8443 --ssl --cert /etc/ssl/server.crt --key /etc/ssl/server.key -S; \
    else \
      tini -- http-server dist -p 8080; \
    fi