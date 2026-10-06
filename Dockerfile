FROM node:22-bookworm-slim

WORKDIR /app

# Keep devDependencies (typescript) so the one-shot "verify" service can run a
# clean build, tests and the smoke check inside the container.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

USER node

CMD ["node", "dist/server.js"]
