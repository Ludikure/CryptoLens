FROM node:20-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8787
EXPOSE 8787
# tiny, zero-dependency service
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1
CMD ["node", "server.js"]
