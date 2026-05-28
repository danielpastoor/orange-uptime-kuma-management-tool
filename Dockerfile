FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# customers.db lives here — mount as a volume to persist across restarts
VOLUME ["/app/data"]

ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION

EXPOSE 4000

CMD ["node", "server.js"]
