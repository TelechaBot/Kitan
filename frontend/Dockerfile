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

# 全局安装 serve 包
RUN npm install -g serve

# 清理不必要文件
RUN npm uninstall -g serve && \
    apk --no-cache add tini

# 暴露端口
EXPOSE 80

# 使用 serve 启动服务
CMD ["tini", "--", "serve", "-s", "dist", "-l", "80"]