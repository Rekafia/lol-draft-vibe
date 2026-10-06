FROM node:24-alpine

WORKDIR /app

# install only production dependencies (cached as long as package*.json don't change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=9020
EXPOSE 9020

# run as the non-root user that comes with the node image
USER node

CMD ["node", "server.js"]
