# Build from the repository root:  docker build -f safeshe-server/Dockerfile -t safeshe .
# Needs DATABASE_URL (Postgres) at runtime.
FROM node:22-alpine
WORKDIR /app
COPY safeshe-server/package.json safeshe-server/package-lock.json ./safeshe-server/
RUN cd safeshe-server && npm ci --omit=dev
COPY safeshe-server/src ./safeshe-server/src
COPY safeshe-android/assets ./safeshe-android/assets
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "safeshe-server/src/server.js"]
