FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9.15.5

COPY . .

ENV NODE_ENV=development

RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm -C artifacts/api-server run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN npm install -g pnpm@9.15.5

COPY . .
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/artifacts/api-server/dist /app/artifacts/api-server/dist

EXPOSE 3000

CMD ["node", "artifacts/api-server/dist/index.mjs"]

