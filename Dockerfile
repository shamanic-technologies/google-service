FROM node:22.23.4-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.4-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY openapi.json ./openapi.json
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/index.js"]
