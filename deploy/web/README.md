# Frink web mode

The full Frink UI in a browser. Electron's main process runs headless in a container (Xvfb, never
shown); browser tabs replace the desktop window over an authenticated HTTP + WebSocket server
(`src/main/lib/web-host/`). Off unless `FRINK_WEB_PORT` is set, so the desktop build is unchanged.

## Build

```sh
bun install --frozen-lockfile
bun run build
docker build -f deploy/web/Dockerfile -t frink-web:dev .                               # this machine
docker buildx build --platform linux/amd64 -f deploy/web/Dockerfile -t <registry>/frink-web:<tag> --push .  # Hostim
```

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `FRINK_WEB_PASSWORD_HASH` | yes (or `FRINK_WEB_PASSWORD`) | Sign-in. Make it with `printf '%s' "$PW" \| node deploy/web/hash-password.mjs`. Both are removed from the environment before agents start |
| `FRINK_WEB_ORIGINS` | yes on a domain | Exact public origin(s), e.g. `https://frink.example.com`. Also the allowed Host headers |
| `FRINK_WEB_SECURE_COOKIES` | yes on HTTPS | `1` marks the session cookie Secure |
| `FRINK_WEB_TRUST_PROXY` | behind a TLS proxy | `1` honours `X-Forwarded-Proto/For` |
| `FRINK_WEB_PORT` | preset `8080` | Listen port |
| `FRINK_WEB_ROOTS` | preset `/workspace` | Folders the browser folder picker may open |
| `FRINK_WEB_MAX_FLOW_RUNS` | no | Seeds Settings → Flows "max runs at once" on first boot only. Use `1` on a 2 GB plan |
| `FRINK_WEB_MAX_HEAP_MB` | no | Caps the main process JS heap |
| `FRINK_WEB_OPENCODE_PROVIDERS` | no | OpenAI-compatible model providers for OpenCode, as JSON: `{"model":"id/model","providers":{"<id>":{"name","baseURL","models":[...],"apiKey"}}}`. Seeded at each start into `~/.frink/opencode/providers.json` (no keys) and OpenCode's sign-in store, then removed from the environment |

## Hostim (2 GB plan)

Measured: about 250 MB idle with a signed-in tab under a hard 2 GB limit (arm64; ~470 MB under
amd64 emulation). Agent runs add their own memory, so keep one Flow run at a time.

```sh
hostim volumes create frink-home --plan vol-1
hostim deploy frink --docker-image <registry>/frink-web:<tag> --plan sa-2-2 --port 8080 \
  --health-check-path /__frink/health \
  --volume frink-home:/home/frink \
  --env FRINK_WEB_ORIGINS=https://<domain> --env FRINK_WEB_SECURE_COOKIES=1 \
  --env FRINK_WEB_TRUST_PROXY=1 --env FRINK_WEB_MAX_FLOW_RUNS=1 --env FRINK_WEB_MAX_HEAP_MB=768 \
  --env FRINK_WEB_ROOTS=/home/frink/projects \
  --env-file <file holding FRINK_WEB_PASSWORD_HASH>
```

The container starts as root only to hand the freshly mounted volume to the `frink` user, then
drops privileges. Only `/home/frink` is persistent on Hostim, so projects go in
`/home/frink/projects` (created on boot); `/workspace` would be lost on redeploy. Agents run unsandboxed with full access to the container: keep platform secrets
out of its environment.
