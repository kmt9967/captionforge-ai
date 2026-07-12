# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg ca-certificates

COPY scripts/judge.mjs ./scripts/judge.mjs

CMD ["node", "scripts/judge.mjs"]
