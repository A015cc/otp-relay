FROM oven/bun:1-alpine

WORKDIR /app
COPY server.js ./

ENV PORT=8099
EXPOSE 8099

CMD ["bun", "server.js"]
