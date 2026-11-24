# Build the web app, then run the API server, which also serves web/dist. Same pattern as the other labs.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7828
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server/src server/src
# The Story/video wording file, served at GET /api/story and read by the recorded video. The rest of video/ stays out of the image.
COPY video/captions.md video/captions.md
COPY --from=build /app/web/dist web/dist
# The signing keys are generated at first start and kept here (mode 600). A named volume mounted on /data inherits this ownership.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 7828
# Inside the container the server must listen on all interfaces, so SPIFFE_BIND is set here on purpose.
# The compose file publishes the port on 127.0.0.1 only; do not publish it more widely.
ENV SPIFFE_BIND=0.0.0.0
CMD ["node", "server/src/index.js"]
