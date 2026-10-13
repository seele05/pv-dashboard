FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY main.js config.example.js ./
COPY lib ./lib
COPY web ./web

# Zustand (solardaily-state.json) liegt im Volume /app/data
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

# Build-Commit (Kurz-Hash), von der CI per --build-arg gesetzt; erscheint in der Fusszeile
ARG GIT_REVISION=
ENV GIT_REVISION=$GIT_REVISION

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/pv').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# config.js wird eingebunden (siehe docker-compose.yml); ohne config.js: --mock anhaengen
CMD ["node", "main.js"]
