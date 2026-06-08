FROM node:20-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends libreoffice && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY . .

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile
RUN pnpm run build

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "--enable-source-maps", "dist/index.js"]

