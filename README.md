<div align="center">
  <img src="docs/images/logo.svg" width="72" alt="">
  <h1>Incus WebUI</h1>
  <p>A web interface for <a href="https://linuxcontainers.org/incus/">Incus</a> and IncusOS. One binary, no database, runs as a container on the server it manages.</p>

  <a href="https://github.com/baki2001/Incus-WebUI/releases/latest"><img src="https://img.shields.io/github/v/release/baki2001/Incus-WebUI?include_prereleases&label=release" alt="Latest release"></a>
  <a href="https://github.com/baki2001/Incus-WebUI/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/baki2001/Incus-WebUI/ci.yml?branch=main&label=build" alt="Build status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/baki2001/Incus-WebUI" alt="License"></a>
</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/instances-dark.png">
  <img alt="The instances page, listing containers with their state, address, CPU and memory" src="docs/images/instances-light.png">
</picture>

> [!NOTE]
> This is an early test release (0.1). It works against real servers, but expect rough edges and report them in [issues](https://github.com/baki2001/Incus-WebUI/issues).

## Features

- Instances: create, start, stop, pause, snapshot, restore and delete, with filters that show counts per value.
- Terminal, console and files for every instance, each on its own tab:
  - Terminal opens a new shell inside the instance, the same as `incus exec`.
  - Console shows the instance's own screen, the same as `incus console`. VMs get a graphic mode (SPICE) and a text mode. Use it when the network or the OS inside is broken.
  - File Explorer browses, uploads, downloads and edits files.
- Hardware settings as a form (CPU, memory, disks, network cards, autostart, snapshot schedule), with a YAML view and a diff to review before anything is applied.
- Several Incus servers in one place. Connect a server by pasting a trust token.
- Sign in with a password, with single sign-on (OIDC), or both.
- Updates from the UI, for the UI itself and for Incus (IncusOS, or Debian and Ubuntu with a small helper).
- Light and dark mode, plus a server-wide theme with your own accent colour.
- A command menu on <kbd>Ctrl</kbd> <kbd>K</kbd> to jump to any instance or action.

## Install

On a Debian or Ubuntu machine that runs Incus, this sets the UI up as a container called `incus-webui`:

```sh
curl -fsSL https://raw.githubusercontent.com/baki2001/Incus-WebUI/main/install/incus-instance.sh | sudo bash
```

It prints the address and a one-time setup code. Open the address, enter the code and pick a username and password. Updates install from Settings, Updates and about.

The [install guide](docs/install.md) explains each step, how to do it by hand, and the other ways to run it: as a plain binary on any Linux machine, or as an OCI image.

## How it works

The binary serves the interface and forwards API calls to each Incus server over HTTPS, using its own client certificate. Your browser never talks to Incus directly and never holds an Incus certificate. Settings, users and the list of servers live in one `config.yaml` file.

Everyone who signs in can do everything on every connected server. Per-user permissions are planned.

## Development

You need Go 1.26 and Node 22.

```sh
make build                       # builds the UI and the binary
./incus-webui --data ./data      # serves https://localhost:8443
```

For UI work, keep the binary running and start `npm run dev` in `web/`. Vite forwards API calls to port 8443.

## License

[Apache 2.0](LICENSE)
