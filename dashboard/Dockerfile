# Build the Angular app, then serve it (and proxy the API/WebSocket) with nginx.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
# Static SPA output.
COPY --from=build /app/dist/dashboard/browser /usr/share/nginx/html
# nginx config that serves the SPA and reverse-proxies /api, /healthz, /ws
# to the server container (service name "server" on the compose network).
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
