FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ws.js games.js filter.js storage.js index.html admin.html terms.html privacy.html favicon.svg og.png ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
