# Dockerfile
FROM node:14-alpine as build

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

# 可选：如果需要，设置 CLOUDFLARE_SITE_KEY
# ARG VITE_CLOUDFLARE_SITE_KEY
# ENV VITE_CLOUDFLARE_SITE_KEY=$VITE_CLOUDFLARE_SITE_KEY

# 构建项目
RUN npm run build

FROM nginx:alpine

# 从构建阶段复制构建好的资产
COPY --from=build /app/dist /usr/share/nginx/html

# 复制自定义 nginx 配置
COPY nginx.conf /etc/nginx/nginx.conf

# 为 SSL 证书创建目录
RUN mkdir -p /etc/nginx/ssl

# 暴露 80 和 443 端口, 10223为测试端口
EXPOSE 80 443 10223

CMD ["nginx", "-g", "daemon off;"]

# 修改nginx.conf后，构建镜像
# docker build --build-arg VITE_BACKEND_URL=https://api.example.com -t kitan-frontend .

# Run
# docker run -d -p 80:80 -p 443:443 -p 10223 -v /path/to/ssl/certs:/etc/nginx/ssl kitan-frontend