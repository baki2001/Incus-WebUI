VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build web run clean

build: web
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o incus-webui .

web:
	cd web && npm ci --no-audit --no-fund && npm run build

run: build
	./incus-webui --data ./data --listen :8443

clean:
	rm -f incus-webui
