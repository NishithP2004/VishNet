FROM node:latest
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package*.json .
RUN npm ci --force
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]