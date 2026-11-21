# WireGuard tunnels

Networking, Tunnels sets up [WireGuard](https://www.wireguard.com/) for you. It has three wizards. All of them keep WireGuard off the Incus host: the UI creates a small gateway container, writes the config into it and manages it from there.

## What each wizard does

**Remote access** lets your own devices reach your networks from outside. You pick the networks to expose, the public address or DNS name your devices will connect to, and a UDP port. Forward that port on your router to the Incus machine. Then add devices: each one gets a config file and a QR code to scan with the WireGuard app. Removing a device cuts it off right away.

**Homelab to VPS** connects the gateway to a small server with a public address, so you can publish services without opening your home router. The wizard gives you a script to run as root on the VPS. You can also add ports to publish: a public port on the VPS is forwarded through the tunnel to a port on one of your instances.

**Monitor an existing tunnel** adds an instance that already runs WireGuard to the Tunnels page, so you can see its peers, last handshakes and traffic. It changes nothing in that instance.

## Requirements

- The `wireguard` kernel module on the Incus host. If a gateway fails to start with a kernel error, run `modprobe wireguard` on the host and try again.
- A Debian or Ubuntu container image on the server. Pull one on the Images page first. The wizards are tested with these images.
- For Homelab to VPS, a VPS that runs Debian or Ubuntu and that you can reach as root.
- A managed bridge network with an IPv4 address for each network you expose.

## Security model

- The gateway is an unprivileged container. The host never runs WireGuard.
- The gateway makes its own private key and keeps it. The UI only reads the public key.
- Device and VPS keys are made in your browser. The UI server sees public keys and the preshared key, which both ends need.
- Tunnel peers can't reach the Incus host itself (its bridge address is blocked) or the gateway, apart from ping.
- With a VPS tunnel, only the VPS can reach your network, and only the ports you published. The VPS drops everything else headed into the tunnel.
- The VPS script contains the VPS private key. Run it, then close the sheet.

## Limits

- IPv4 only. The tunnel subnet must be a private range such as `10.66.0.0/24`.
- The gateway needs internet access through its network the first time, to install the WireGuard packages.
- The VPS firewall is not changed. Allow the tunnel port, and any published ports, yourself (for example `ufw allow 51820/udp`).
- Only Debian and Ubuntu images are tested.
