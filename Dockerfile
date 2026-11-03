FROM node:22-alpine
WORKDIR /app
RUN npm install --no-package-lock --no-audit --no-fund --omit=dev --omit=optional ws@8.22.0 \
    && npm cache clean --force
COPY server.js ./
EXPOSE 10000
ENV NODE_ENV=production
CMD ["node", "server.js"]
