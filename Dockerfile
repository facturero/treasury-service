FROM node:20-alpine AS builder
ARG NODE_AUTH_TOKEN
WORKDIR /app
COPY package*.json ./
RUN printf '@facturero:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" > .npmrc \
    && npm ci \
    && rm -f .npmrc
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine
ARG NODE_AUTH_TOKEN
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY package*.json ./
RUN printf '@facturero:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" > .npmrc \
    && npm ci --omit=dev && npm cache clean --force \
    && rm -f .npmrc
COPY --from=builder /app/dist/ dist/
COPY migrations/ migrations/
COPY .sequelizerc .sequelizerc
COPY sequelize.config.cjs sequelize.config.cjs
USER app
EXPOSE 3018
CMD ["node", "dist/main.js"]
