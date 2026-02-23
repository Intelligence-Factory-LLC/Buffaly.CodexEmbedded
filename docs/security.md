# Security Guidance

Treat this like SSH to your dev machine.

This project can execute commands and modify files through Codex. A user who can access the UI should be treated as having privileged access to the host.

Never expose publicly.

Use tailnet-only.

## Threat Model

If an attacker can access the UI or websocket channel, they may be able to:

- Execute arbitrary commands through Codex tools.
- Read, create, modify, and delete files the process can access.
- Trigger external network calls from tools.
- Exfiltrate sensitive data shown in prompts, logs, or tool outputs.

Assume compromise impact is similar to giving an untrusted party shell-level influence over your development environment.

## Recommended Deployment

- Bind the web host to `127.0.0.1` / `localhost`.
- Keep websocket auth enabled.
- Publish privately via Tailscale Serve to your tailnet.
- Restrict host filesystem permissions to least privilege.

Recommended pattern:

1. App listens locally only.
2. Tailscale Serve publishes local port to tailnet HTTPS URL.
3. Access from trusted tailnet devices only.

## Auth Modes

- Default: websocket auth token required.
- Token required for `/ws`; disable only for local dev.
- Token is explicit configuration only. No startup-random websocket token is generated when auth is enabled.
- If `WebSocketAuthRequired=true`, `WebSocketAuthToken` must be configured or server startup fails fast.
- Optional hardening: combine token auth with Tailscale device/user controls and ACL policy.

## Unsafe Configurations

Avoid these for this project:

- Binding to `0.0.0.0`, `*`, or non-local interfaces without additional network controls.
- Public reverse proxy exposure.
- Tailscale Funnel/public internet routes.
- Disabling websocket auth outside isolated local testing.

## Logging Considerations

- Do not log auth tokens or secrets.
- Avoid querystring secrets; prefer headers/cookies for sensitive values.
- Treat tool output logs as sensitive data.
- Avoid storing logs on shared/public locations.

## Troubleshooting Boundaries

- Issues and PRs are welcome.
- Best-effort support only; no SLA.
- Validate your network exposure and auth settings before reporting runtime bugs.

Built by Buffaly, Intelligence Factory LLC: https://buffa.ly
