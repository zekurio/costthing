# syntax=docker/dockerfile:1

FROM denoland/deno:2.4.2 AS build
WORKDIR /app
COPY deno.json deno.lock ./
COPY shared ./shared
COPY frontend ./frontend
RUN deno install && deno task frontend:build

FROM denoland/deno:2.4.2
WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
COPY shared ./shared
COPY --from=build /app/frontend/dist ./frontend/dist
RUN deno cache src/main.ts

ENV PORT=8080 \
    DATA_FILE=/data/costs.json \
    STATIC_DIR=/app/frontend/dist
EXPOSE 8080
VOLUME ["/data"]
CMD ["run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "src/main.ts"]
