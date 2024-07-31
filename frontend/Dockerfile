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

# 全局安装 serve 包
RUN npm install -g serve

# 从构建阶段复制构建好的资产
COPY --from=build /app/dist /app/dist

# 设置工作目录
WORKDIR /app

# 暴露端口
EXPOSE 5000

# 使用 serve 启动服务
CMD ["serve", "-s", "dist", "-l", "5000"]

# 构建镜像
# docker build --build-arg VITE_BACKEND_URL=https://api.example.com -t kitan-frontend .

# 运行容器
# docker run -d -p 5000:5000 kitan-frontend