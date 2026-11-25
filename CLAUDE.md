# Notes for Claude

Two people work on this repo, each with Claude Code. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branches, PRs and releases. The short version:

- Open every PR against `dev`, never `main`, unless the user asks for a hotfix or a release PR.
- One change per PR. Check open PRs first and say so if someone else is working on the same area.
- Run `cd web && npm run build`, `go vet ./...` and `go test ./...` before pushing. The web build also checks `web/src/extra.css` for broken braces.
- Don't merge into `main` and don't run the Release workflow unless the user asks for it.
- Keep release asset names (`incus-webui-linux-<arch>`, `SHA256SUMS`, `incus-instance.sh`, `host-updates.sh`) as they are. The in-app updater and the install script depend on them.
- Write docs, PR text and UI copy in plain, short sentences.

## Project

One Go binary that serves a React UI (`web/`, embedded from `web/dist`) and proxies the Incus API. Settings live in one YAML file (`config.go`), there's no database. Self-update and the stable/dev update channels are in `update.go`. Test against Incus 6.0 API shapes, since Debian and Ubuntu ship 6.0.
