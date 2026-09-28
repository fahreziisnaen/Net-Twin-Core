# ---- Build stage: compile the Vite frontend + bundle the Express server ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# dist/ is the public web root (frontend only); the server bundle lives
# outside it so it can never be downloaded over HTTP.
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# JSON file storage (only used when DB_HOST is unset) writes to /app/data.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist-server/server.cjs"]
