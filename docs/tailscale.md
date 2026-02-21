Tailscale setup and troubleshooting

This project is intended to be accessed privately over a tailnet. The recommended deployment is:

App binds to localhost (127.0.0.1) only

Tailscale Serve publishes that localhost port to your tailnet only over HTTPS

You access it from your phone or other devices while on the tailnet

Do not expose this app directly to the public internet.

Prerequisites

Tailscale installed and logged in on:

the machine running this UI

each client device (phone, laptop, etc.)

You have access to the Tailscale admin console for your tailnet.

Enable MagicDNS and HTTPS certificates

In the Tailscale admin console:

1. DNS: enable MagicDNS

2. DNS: enable HTTPS certificates

On each device, ensure it accepts tailnet DNS:

Windows PowerShell:

tailscale set --accept-dns=true

If a client cannot resolve device.tailnet.ts.net, run the command above on that client and retry.

Publish the web UI port to the tailnet

Assume the UI is running on the machine at: http://127.0.0.1:5173

On the same machine:

tailscale serve --bg 5173
tailscale serve status

serve status prints a tailnet-only URL like: https://win.<tailnet>.ts.net/

Open that URL from another device on the same tailnet.

To remove all serve mappings:

tailscale serve reset

Serving multiple local ports from the same machine

Tailscale Serve can map multiple upstreams using path prefixes (slugs). This is the standard way to expose multiple apps from one box.

Example:

/dev proxies to 127.0.0.1:5173

/api proxies to 127.0.0.1:5001

tailscale serve reset
tailscale serve --bg /dev http://127.0.0.1:5173
tailscale serve --bg /api http://127.0.0.1:5001
tailscale serve status

Then access:

https://win.<tailnet>.ts.net/dev/

https://win.<tailnet>.ts.net/api/

Important: apps that assume they live at /

Many web apps break when mounted under a slug because their JS/CSS uses root-relative paths like /site.css or /app.js.

If your app breaks under a slug, you have three options:

Option A (recommended): run the app under the same path base locally and remotely

Configure the server to use PathBase (example /dev)

Access locally at http://127.0.0.1:5173/dev/

Access remotely at https://win.<tailnet>.ts.net/dev/

Option B: update the app to support a base path

Ensure asset URLs are relative (no leading /)

Use <base href="./"> for static sites so assets resolve under either / or /slug/

Option C: put a real reverse proxy in front that strips the prefix

Use Caddy or Nginx locally to rewrite paths

Point Tailscale Serve at the proxy This is useful if you cannot change the app, but it adds complexity.

Upstream is HTTPS only (common for local dev servers)

If your local upstream is HTTPS-only on localhost, do not proxy to http://127.0.0.1:<port>. That causes 502 or empty responses.

Instead proxy to https.

Trusted cert:

tailscale serve reset
tailscale serve --bg https://127.0.0.1:58176
tailscale serve status

Self-signed or invalid cert:

tailscale serve reset
tailscale serve --bg https+insecure://127.0.0.1:58176
tailscale serve status

If you see a 502 from the client device, test locally on the host:

curl -v  http://127.0.0.1:58176/
curl -vk https://127.0.0.1:58176/

If HTTP fails and HTTPS works, your Serve mapping must use https or https+insecure.

Troubleshooting checklist

DNS does not resolve (hostname not found)

Symptoms:

Browser: cannot resolve host

nslookup fails

Fix on the client device:

tailscale set --accept-dns=true

Then validate:

nslookup win.<tailnet>.ts.net 100.100.100.100

Also validate connectivity:

tailscale ping win

502 Bad Gateway

This means Tailscale Serve can reach your device but cannot reach the upstream you configured.

Common causes:

Upstream is HTTPS but Serve mapping uses HTTP

Upstream port changed or process is not listening

Upstream only binds to a different interface

Validate upstream is listening:

netstat -ano | Select-String ":58176\s"
curl -v  http://127.0.0.1:58176/
curl -vk https://127.0.0.1:58176/

Then fix mapping accordingly (http vs https vs https+insecure).

UI loads but JS/CSS is broken when using a slug

This is almost always path base mismatch.

Check DevTools Network tab:

If requests go to /slug/app.js but your server serves /app.js, you need PathBase support or prefix stripping.

If requests go to /app.js but you expected /slug/app.js, your app is using root-relative asset paths and cannot be mounted under a slug without changes.

Preferred fix:

Configure PathBase in the server so it can run under the same prefix locally and remotely.

Device naming

Your Serve URL is derived from the device name in your tailnet.

Rename the device in the Tailscale admin console (Machines) to something memorable like:

win

buffaly-dev

codex-host

After renaming, the URL becomes: https://<device>.<tailnet>.ts.net/

Serve vs Funnel

Use Serve for tailnet-only access. This is the recommended configuration.

Funnel makes the service publicly reachable from the internet and should not be used for this project.

Security notes

Keep the web server bound to localhost and publish via Tailscale Serve.

Do not expose this service publicly.

Treat approvals and command execution as privileged operations.

If you enable non-local binding, add authentication at the web layer.
