FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg chromium
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
COPY package*.json .
RUN npm ci --force
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]