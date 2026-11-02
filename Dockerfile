# 构建应用
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_SONG_PROVIDER=meting
ENV VITE_SONG_PROVIDER=$VITE_SONG_PROVIDER
RUN npm run build

# 最小化镜像
FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/music.example.json ./music.example.json
ENV PORT=12445
ENV HOST=0.0.0.0

EXPOSE 12445
CMD ["node", "server/index.mjs"]
