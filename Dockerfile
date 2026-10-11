FROM node:20-slim AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
COPY frontend/package*.json ./frontend/
RUN npm ci
RUN npm ci --prefix frontend

FROM deps AS builder
COPY . .
RUN npm run build

FROM node:20-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/server ./server
COPY --from=builder /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
