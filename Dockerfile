# OMEN: game + payment gateway + Socket.IO in one Node process.
# Hosts like Render, Fly.io and Railway terminate TLS, so browsers connect with https:// and wss://.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# VITE_* values are baked into the browser bundle at build time (public by design).
ARG VITE_ARKIV_ACCESS_KEY=""
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server/main.js"]
