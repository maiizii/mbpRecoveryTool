# syntax=docker/dockerfile:1.4
ARG NODE_VERSION=20.12.2
FROM node:${NODE_VERSION}-alpine AS base

LABEL org.opencontainers.image.source=https://github.com/yourorg/myt-recovery-tool

WORKDIR /app

# Node.js dependencies
FROM base AS deps
RUN apk add --no-cache libc6-compat python3 openssh-client curl unzip tar rsync coreutils grep sed
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then pnpm i --frozen-lockfile; \
  else echo "No lockfile found, running npm install"; npm install; \
  fi

# Build stage (if needed, currently for web assets)
FROM base AS build
RUN apk add --no-cache python3 openssh-client curl unzip tar rsync coreutils grep sed
COPY . .
# If there are any build steps for the web assets, add them here.
# For example: RUN npm run build-web

# Final stage
FROM base AS runner
RUN apk add --no-cache libc6-compat python3 openssh-client curl unzip tar rsync coreutils grep sed

COPY --from=build /app/src ./src
COPY --from=build /app/web ./web
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config.example.json ./config.example.json
COPY --from=build /app/README.md ./README.md

ENV NODE_ENV=production
ENV PORT=23321
ENV CONFIG_PATH=/app/data/config.json
ENV DATA_DIR=/app/data
ENV JOBS_DIR=/app/data/jobs
ENV UPLOADS_DIR=/app/data/uploads
ENV SECRETS_DIR=/app/data/secrets

EXPOSE 23321

CMD ["node", "src/gui-server.js"]
