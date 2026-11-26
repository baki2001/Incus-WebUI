# Alerts

The UI can send a short message when something needs a look. Set it up under Settings, Alerts. Only admins see that page.

## Where alerts go

Add one or more places. Every alert goes to each of them. Test sends a message right away, so you know it arrives.

- **ntfy**: the full topic address, like `https://ntfy.sh/my-incus-alerts`, or a topic on your own ntfy server. Add an access token for a protected topic.
- **Discord**: a channel webhook address, from the channel's settings under Integrations.
- **Slack**: an incoming webhook address.
- **Gotify**: the server address and an application token.
- **Email**: the mail server, its port, a username and password if it needs them, who it's from and who it goes to. Port 465 uses TLS from the start. Other ports switch to TLS with STARTTLS when the server offers it.
- **Webhook**: any address that takes a JSON POST. The body looks like this:

```json
{
  "source": "incus-webui",
  "kind": "pool",
  "title": "Pool default is 91% full",
  "message": "…",
  "server": "home",
  "problem": true,
  "time": "2026-11-26T21:14:00Z",
  "url": "https://incus.example.com/..."
}
```

`kind` is one of `backup`, `offline`, `pool`, `warning`, `update` or `test`. `problem` is false for good news, like a server that's back online.

Tokens and passwords stay in `config.yaml` and are never sent back to the browser.

## What to send

Each alert can be turned off on its own:

- **Backup or test restore failed**: a scheduled backup run failed, or its Sunday test restore did.
- **Server offline**: the UI couldn't reach a server two checks in a row. A second message says when it's back.
- **Storage pool almost full**: a pool passed 85% or 90%, your choice. It alerts once, and again only after the pool dropped 5 points below the limit and filled up again.
- **New Incus warning**: Incus raised a warning it didn't have before. Warnings that were there when you set up alerts don't count.
- **Update available**: a new version of the UI is out on the update channel you follow.

The UI checks every five minutes, so an alert can take that long. Set `public_url` in `config.yaml` to get a link back to the UI in each message.

There are no rules to write and nothing else to run. For anything more involved, point Prometheus at Incus's own metrics.
