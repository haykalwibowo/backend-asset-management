# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
# DATABASE_URL dummy, hanya supaya prisma generate bisa jalan saat build
RUN DATABASE_URL="mysql://u:p@localhost:3306/db" npx prisma generate

COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./

RUN mkdir -p uploads && chown -R node:node /app
USER node

EXPOSE 5000
# Jalankan migration dulu, baru start API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
