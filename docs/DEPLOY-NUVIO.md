# Deploying the Nuvio build to your Docker server

Your changes live in your fork: `https://github.com/paparei/StremioSubMaker` (commit `7836b59`).
The Docker Hub image `xtremexq/submaker:latest` does NOT contain them — you must build from your fork.

## Option A — build on the server (recommended)

```bash
# 1) Get your fork on the server (first time only)
git clone https://github.com/paparei/StremioSubMaker.git
cd StremioSubMaker

# 2) Reuse your existing .env (keys, Redis settings, etc.)
cp /path/to/your/current/deployment/.env .env

# 3) Build and start (uses the repo's docker-compose.yaml, which builds locally)
docker compose up -d --build

# 4) Watch it come up
docker compose logs -f submaker
```

Updating later:

```bash
cd StremioSubMaker
git pull
docker compose up -d --build
```

## Option B — keep your current compose file (image-based)

If your server's `docker-compose.yaml` uses `image: xtremexq/submaker:latest`,
build your fork and point the compose file at the local image:

```bash
git clone https://github.com/paparei/StremioSubMaker.git
cd StremioSubMaker
docker build -t submaker:nuvio .
```

Then in your compose file replace:

```yaml
    image: xtremexq/submaker:latest
```

with:

```yaml
    image: submaker:nuvio
```

and run:

```bash
docker compose up -d
```

## Troubleshooting

### `ERROR: docker: 'docker buildx build' requires 1 argument`

Your server has the old standalone `docker-compose` (v1), which mishandles `build: .`.
Two fixes, pick one:

**Fix 1 — use the Compose v2 plugin (space, no hyphen):**
```bash
docker compose version          # must print v2.x
docker compose up -d --build
```

**Fix 2 — build the image yourself, then start without --build:**
```bash
docker build -t submaker:nuvio .
```
Then in `docker-compose.yaml`, add an `image:` line right above `build: .`:
```yaml
  submaker:
    image: submaker:nuvio
    build: .
```
Then start without building:
```bash
docker-compose up -d
```

## Important

- Keep your existing volumes (especially `encryption-key` / `keys` and `redis-data`) —
  they hold your encryption key and cached translations. Do not delete them.
- No new required env vars. Optional Nuvio tuning:
  - `NUVIO_SEARCH_TIMEOUT_MS` (default `15000`) — subtitle search cap for Nuvio clients
  - `NUVIO_WAIT_TIMEOUT_MS` (default `18000`) — how long Nuvio waits for a translation
- If you run behind a reverse proxy, keep `TRUST_PROXY=1` as before.
- Verify: open `http://your-server:7001/health` (or your usual health check),
  then test in Nuvio — the `vi-Make` / `en-Make` style entries should appear and
  return finished (or partial) subtitles instead of a stuck loading placeholder.
