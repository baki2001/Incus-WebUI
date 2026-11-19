# Builds the single incus-webui binary and ships it in a tiny image.
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.24-alpine AS bin
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/incus-webui . \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source=https://github.com/baki2001/Incus-WebUI \
      org.opencontainers.image.description="Web interface for Incus and IncusOS" \
      org.opencontainers.image.licenses=Apache-2.0
COPY --from=bin /out/incus-webui /usr/local/bin/incus-webui
COPY --from=bin --chown=65532:65532 /out/data /data
ENV INCUS_WEBUI_DATA=/data
VOLUME /data
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/incus-webui"]
