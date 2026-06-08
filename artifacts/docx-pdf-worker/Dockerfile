FROM node:20-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends \
  libreoffice \
  fontconfig \
  fonts-liberation \
  fonts-dejavu \
  fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY . .

COPY fonts-local.conf /etc/fonts/local.conf
RUN fc-cache -f

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --no-frozen-lockfile
RUN pnpm run build

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "--enable-source-maps", "dist/index.js"]
