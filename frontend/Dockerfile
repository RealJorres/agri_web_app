FROM node:22-alpine

WORKDIR /app

# Dependencies live in a named volume in dev; this layer seeds it on first run.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev"]
