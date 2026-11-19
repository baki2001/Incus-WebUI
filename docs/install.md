# Install guide

Incus WebUI is one binary. You can run it in three ways:

1. [As a container on your Incus server](#as-a-container-on-incus). Recommended, and the quickest.
2. [As a binary on any Linux machine](#as-a-binary-on-any-linux-machine), for example one that manages several Incus servers.
3. [As an OCI image](#as-an-oci-image) with Docker, Podman, or Incus 6.3 and newer.

You need Incus 6.0 or newer. The `incus` package in Debian 13 and in Debian 12 backports works, and so do the Zabbly packages. The UI runs on x86-64 and ARM64.

## As a container on Incus

Run this on the Incus server:

```sh
curl -fsSL https://raw.githubusercontent.com/baki2001/Incus-WebUI/main/install/incus-instance.sh | sudo bash
```

When it finishes, it prints something like this:

```
==> Incus WebUI is running.
    Open        https://192.168.1.20:9443
    Setup code  3f9a1c07be52
```

Open the address in a browser. It warns about the certificate the first time, because the UI made its own; accept it. Enter the setup code and choose a username and a password of at least 10 characters. You land on the overview with this server already connected.

### What the script does

You can read the script first: [install/incus-instance.sh](../install/incus-instance.sh). In order, it:

1. Downloads the latest release for your CPU from GitHub and checks its SHA-256 sum.
2. Sets `core.https_address` if it is empty, so the UI can reach Incus over HTTPS. It uses the address of the default bridge (for example `10.12.34.1:8443`), which only the host and its containers can reach. If you already set an address, the script leaves it alone.
3. Creates a Debian 13 container named `incus-webui` that starts with the server.
4. Copies the binary into it and adds a systemd service that runs as its own user.
5. Creates a one-time trust token with `incus config trust add incus-webui` and hands it to the UI, which uses it to get its certificate trusted.
6. Adds a proxy device so port 9443 on the host reaches the UI.

You can change the defaults with environment variables:

```sh
curl -fsSL https://raw.githubusercontent.com/baki2001/Incus-WebUI/main/install/incus-instance.sh \
  | sudo NAME=webui PORT=8444 VERSION=v0.1.0 bash
```

| Variable | Default | |
|---|---|---|
| `NAME` | `incus-webui` | Container name |
| `PORT` | `9443` | Port on the host |
| `IMAGE` | `images:debian/13` | Image for the container. It needs systemd. |
| `VERSION` | `latest` | A release tag such as `v0.1.0` |

### Update

Run the install command again. It sees that the container exists, replaces the binary and restarts the service. Your users and servers stay.

### Remove

```sh
incus delete --force incus-webui
incus config trust list            # find the incus-webui entry
incus config trust remove <fingerprint>
```

### The same steps by hand

If you'd rather not pipe a script into a shell, here are the steps. Replace `amd64` with `arm64` on ARM.

```sh
# 1. Let Incus listen on HTTPS (skip if `incus config get core.https_address` prints something)
incus config set core.https_address "$(incus network get incusbr0 ipv4.address | cut -d/ -f1):8443"

# 2. Container and binary
incus launch images:debian/13 incus-webui -c boot.autostart=true
curl -fsSLO https://github.com/baki2001/Incus-WebUI/releases/latest/download/incus-webui-linux-amd64
incus file push incus-webui-linux-amd64 incus-webui/usr/local/bin/incus-webui --mode 0755

# 3. Service user and data folder
incus exec incus-webui -- useradd --system --home-dir /var/lib/incus-webui --shell /usr/sbin/nologin incus-webui
incus exec incus-webui -- install -d -m 0700 -o incus-webui -g incus-webui /var/lib/incus-webui

# 4. Connect it to this server
TOKEN="$(incus config trust add incus-webui --quiet)"
incus exec incus-webui -- runuser -u incus-webui -- incus-webui add-server "$(hostname -s)" "$TOKEN"
```

Then save the [service file](#systemd-service) as `incus-webui.service` and finish:

```sh
incus file push incus-webui.service incus-webui/etc/systemd/system/
incus exec incus-webui -- systemctl enable --now incus-webui
incus config device add incus-webui https proxy listen=tcp:0.0.0.0:9443 connect=tcp:127.0.0.1:8443

# the setup code
incus exec incus-webui -- journalctl -u incus-webui | grep "setup code"
```

## As a binary on any Linux machine

Use this when the UI should live outside the servers it manages, or on a machine without Incus.

```sh
sudo curl -fsSL https://github.com/baki2001/Incus-WebUI/releases/latest/download/incus-webui-linux-amd64 \
  -o /usr/local/bin/incus-webui
sudo chmod 0755 /usr/local/bin/incus-webui
sudo useradd --system --home-dir /var/lib/incus-webui --shell /usr/sbin/nologin incus-webui
```

Save the [service file](#systemd-service) as `/etc/systemd/system/incus-webui.service`, then:

```sh
sudo systemctl enable --now incus-webui
sudo journalctl -u incus-webui | grep "setup code"
```

The UI listens on port 8443. Sign in with the setup code, then add your servers under Settings, Servers ([see below](#connect-more-servers)).

If the machine is itself an Incus server, the UI finds the local socket and adds it on first start. The service user then needs to be in the `incus-admin` group: `sudo usermod -aG incus-admin incus-webui`.

### systemd service

```ini
[Unit]
Description=Incus WebUI
After=network-online.target
Wants=network-online.target

[Service]
User=incus-webui
Group=incus-webui
ExecStart=/usr/local/bin/incus-webui --data /var/lib/incus-webui
StateDirectory=incus-webui
StateDirectoryMode=0700
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

## As an OCI image

Images are published to `ghcr.io/baki2001/incus-webui` for x86-64 and ARM64.

With Docker or Podman:

```sh
docker run -d --name incus-webui -p 9443:8443 -v incus-webui:/data ghcr.io/baki2001/incus-webui:latest
docker logs incus-webui 2>&1 | grep "setup code"
```

With Incus 6.3 or newer, which can run OCI images directly:

```sh
incus remote add ghcr https://ghcr.io --protocol=oci
incus launch ghcr:baki2001/incus-webui incus-webui
incus config device add incus-webui https proxy listen=tcp:0.0.0.0:9443 connect=tcp:127.0.0.1:8443
incus console incus-webui --show-log | grep "setup code"
```

Then add your servers under Settings, Servers.

## Connect more servers

On each Incus server you want to add:

```sh
incus config set core.https_address :8443     # if it isn't set yet
incus config trust add incus-webui            # prints a token, valid once
```

In the UI, open Settings, Servers, pick a name, paste the token and press Add server. The UI checks the server's certificate against the token, gets its own certificate trusted, and remembers the server's certificate for later.

If you can't use a token, choose Address instead, enter `https://host:8443`, and trust the certificate shown on that page with `incus config trust add-certificate`.

## Single sign-on (OIDC)

Single sign-on is set in the config file, `/var/lib/incus-webui/config.yaml`. Register the UI with your provider (Authentik, Keycloak, Pocket ID, Zitadel and others work) with this redirect URL:

```
https://<ui address>/api/ui/oidc/callback
```

Then add:

```yaml
public_url: https://incus.example.com:9443
oidc:
  issuer: https://auth.example.com/application/o/incus/
  client_id: incus-webui
  client_secret: change-me
  button_label: Sign in with Authentik
  allowed_emails: [you@example.com]   # optional
  allowed_groups: [incus-admins]      # optional, read from the "groups" claim
```

Restart the service. Without `allowed_emails` or `allowed_groups`, anyone your provider signs in can use the UI. Password sign-in keeps working next to SSO while there are local users.

## Your own certificate

To use a certificate from your own CA or from Let's Encrypt, point the config at it and restart:

```yaml
tls_cert: /var/lib/incus-webui/tls/fullchain.pem
tls_key: /var/lib/incus-webui/tls/privkey.pem
```

Behind a reverse proxy that handles TLS, set `tls: false` and let the proxy forward to port 8443 over plain HTTP. Make sure it sets `X-Forwarded-Proto: https` and passes WebSocket upgrades, or the terminal and console won't connect.

## Troubleshooting

### I lost the setup code

Run `incus exec incus-webui -- journalctl -u incus-webui | grep "setup code"`. The code changes on every restart until the first account exists.

### I forgot my password

Open `config.yaml`, remove your entry under `users`, and restart. With no users left (and SSO off), the UI prints a new setup code.

### The File Explorer or Terminal says the instance is not reachable

Both need a running instance. Virtual machines also need the Incus agent, which the `images:` VM images include.

### Graphic console is missing

It only exists for virtual machines. Containers have the text console.

### The server shows as "not trusted"

The UI's certificate was removed from the server, or the token was never used. Remove the server under Settings, Servers and add it again with a new token.
