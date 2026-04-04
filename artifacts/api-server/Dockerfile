FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN npm install -g pnpm@9.15.5

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm -C artifacts/api-server run build

EXPOSE 3000

CMD ["node", "artifacts/api-server/dist/index.mjs"]

