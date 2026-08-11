# Standalone production deployment

## Topology

The production VPS already has a shared Caddy edge that owns ports 80/443 for multiple applications. Bright must not start a second Caddy or take ownership of those ports.

```text
Internet -> dramaclaw-caddy-1 :80/:443
                    |
                    | external Docker network: bright-edge
                    v
        bright-standalone-oauth2-proxy :4182
                    |
                    | Bright private backend network
                    v
                 app :4180 ---- durable SQLite/data volume
                                      |
                                      +---- worker / Chromium / FFmpeg
                                             |-- Gemini research/generation
                                             |-- Gemini TTS Preview
                                             +-- Remotion render
```

Bright Compose contains only `oauth2-proxy`, `app`, and `worker`. None publishes a host port. Only `oauth2-proxy` joins `bright-edge` and exposes the stable alias `bright-standalone-oauth2-proxy` for the shared Caddy. `app` and `worker` remain private.

There is no runtime dependency on n8n in the standalone design. The legacy `n8n-bright_default` attachment remains on shared Caddy only during the rollback window and must not be used by the new Bright stack.

## Production values for the current VPS

```text
APP_DOMAIN=video.lanadesign.tech
BRIGHT_EDGE_NETWORK=bright-edge
BRIGHT_EDGE_CIDR=172.23.250.0/29
GITHUB_ALLOWED_USERS=nguyentuanson27-netizen
GITHUB_OAUTH_CLIENT_ID=Iv23liZUM7Hyh5ev1ft3
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_TTS_VOICE=Kore
```

The chosen edge CIDR was checked against the VPS Docker networks and host IPv4 routing before cutover. Re-check routing if the host network topology changes.

Gemini TTS is a Preview dependency. Deterministic CI uses fakes; a real production TTS call is a mandatory smoke test before the legacy stack is retired.

## Host ownership

The shared edge is `dramaclaw-caddy-1`, owned by Compose project `dramaclaw`:

- working directory: `/opt/dramaclaw`
- base Compose: `/opt/dramaclaw/docker-compose.yml`
- Caddy/network override: `/opt/dramaclaw/docker-compose.override.yml`
- Caddyfile: `/opt/dramaclaw/deploy-custom/Caddyfile`

The observed Caddy service already joins `app-net`, `las_default`, and `n8n-bright_default`. During migration keep all three and add `bright-edge`. Do not remove the legacy Bright network until the rollback window is intentionally closed.

## Secrets

Production requires only three Bright secret files:

```text
/srv/bright-profile/secrets/gemini-api-key
/srv/bright-profile/secrets/github-oauth-client-secret
/srv/bright-profile/secrets/oauth2-proxy-cookie-secret
```

Google Cloud service-account credentials are not used. Research, generation, and Gemini TTS share the same Gemini API key and that key is mounted only into the worker. GitHub OAuth secrets are mounted only into `oauth2-proxy`. The app receives no provider/auth secret.

Compose file-backed secrets are bind mounts. Keep the parent directory private while making the mounted files readable by the non-root container users:

```bash
sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /srv/bright-profile/secrets
chmod 0444 \
  /srv/bright-profile/secrets/gemini-api-key \
  /srv/bright-profile/secrets/github-oauth-client-secret \
  /srv/bright-profile/secrets/oauth2-proxy-cookie-secret
```

Do not put secret values in `.env`, shell history, repository files, commands, or chat.

Safe structural preflight that does not print secret contents:

```bash
set -e
SECRET_DIR=/srv/bright-profile/secrets

test "$(stat -c '%a' "$SECRET_DIR")" = 700
for secret in gemini-api-key github-oauth-client-secret oauth2-proxy-cookie-secret; do
  test -s "$SECRET_DIR/$secret"
  test "$(stat -c '%a' "$SECRET_DIR/$secret")" = 444
  printf '%-35s OK size=%s bytes\n' "$secret" "$(stat -c '%s' "$SECRET_DIR/$secret")"
done
test "$(stat -c '%s' "$SECRET_DIR/oauth2-proxy-cookie-secret")" = 32
echo 'SECRET PREFLIGHT: PASS'
```

The old `/srv/bright-profile/secrets/google-tts.json` is not consumed by the standalone stack and may be removed later after rollback dependencies have been checked.

## Deployment environment

Create a deployment-local `.env` from `.env.example`. At minimum set:

```text
BRIGHT_IMAGE=<immutable git-SHA tag or image digest>
APP_DOMAIN=video.lanadesign.tech
BRIGHT_EDGE_NETWORK=bright-edge
BRIGHT_EDGE_CIDR=172.23.250.0/29
GITHUB_ALLOWED_USERS=nguyentuanson27-netizen
GITHUB_OAUTH_CLIENT_ID=Iv23liZUM7Hyh5ev1ft3
GITHUB_OAUTH_CLIENT_SECRET_FILE=/srv/bright-profile/secrets/github-oauth-client-secret
OAUTH2_PROXY_COOKIE_SECRET_FILE=/srv/bright-profile/secrets/oauth2-proxy-cookie-secret
GEMINI_API_KEY_FILE=/srv/bright-profile/secrets/gemini-api-key
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_TTS_VOICE=Kore
GEMINI_TTS_TIMEOUT_MS=30000
```

Keep `BRIGHT_IMAGE` immutable. Do not deploy `latest`.

## Create the dedicated edge network

Create the external network once:

```bash
docker network inspect bright-edge >/dev/null 2>&1 || \
  docker network create --driver bridge --subnet 172.23.250.0/29 bright-edge

docker network inspect bright-edge --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

The second command must report `172.23.250.0/29`.

## Persist shared Caddy on bright-edge

Back up the Dramacl​aw override before editing:

```bash
cd /opt/dramaclaw
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cp -a docker-compose.override.yml "docker-compose.override.yml.before-bright-$stamp"
```

Merge `bright-edge` without removing existing networks:

```yaml
services:
  caddy:
    networks:
      - app-net
      - las_default
      - n8n-bright_default
      - bright-edge

networks:
  # retain existing declarations
  bright-edge:
    external: true
```

Validate the complete resolved Dramacl​aw Compose configuration:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  config >/dev/null
```

A temporary `docker network connect bright-edge dramaclaw-caddy-1` may be used to stage connectivity before a Caddy recreate, but that command is not the durable configuration. The override file must remain the source of truth.

## Validate and start Bright without public cutover

From the verified standalone checkout/image:

```bash
docker compose config
docker compose build app
docker compose up -d app worker oauth2-proxy
docker compose ps
```

Verify private readiness:

```bash
docker compose exec -T app node -e \
  "fetch('http://127.0.0.1:4180/health/ready').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(!b.ok)process.exit(1)})"

docker compose exec -T worker node -e \
  "fetch('http://127.0.0.1:4181/health/ready').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(!b.ok)process.exit(1)})"
```

Verify no Bright service has a host port binding:

```bash
for service in app worker oauth2-proxy; do
  container="$(docker compose ps -q "$service")"
  docker inspect --format='{{json .HostConfig.PortBindings}}' "$container"
done
```

Each result must be `{}` or `null`/empty equivalent.

Verify least privilege without printing secret contents:

```bash
app="$(docker compose ps -q app)"
worker="$(docker compose ps -q worker)"

test "$(docker inspect --format='{{.Config.User}}' "$app")" != root
test "$(docker inspect --format='{{.Config.User}}' "$worker")" != root

test -z "$(docker inspect --format='{{range .Mounts}}{{if eq .Destination \"/run/secrets/gemini_api_key\"}}mounted{{end}}{{end}}' "$app")"
docker compose exec -T worker node -e \
  "const fs=require('node:fs');if(!fs.statSync('/run/secrets/gemini_api_key').isFile())process.exit(1);if(fs.existsSync('/run/secrets/google_tts_credentials'))process.exit(1)"
```

## Shared Caddy cutover

Keep the legacy Bright stack running. Back up the live Caddyfile:

```bash
cd /opt/dramaclaw
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cp -a deploy-custom/Caddyfile "deploy-custom/Caddyfile.before-bright-$stamp"
```

The target Bright site block is:

```caddyfile
video.lanadesign.tech {
  encode gzip
  reverse_proxy bright-standalone-oauth2-proxy:4182
}
```

Remove the old `header_up X-Bright-Api-Key ...` directive. The legacy API token has already been exposed and must not be copied into the standalone configuration.

Validate before reload:

```bash
docker exec dramaclaw-caddy-1 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Apply a zero-downtime reload, not a container restart:

```bash
docker exec dramaclaw-caddy-1 \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Caddy must remain the only process publishing host ports 80/443.

## Authentication smoke

Before calling auth verified:

1. An unauthenticated request to `https://video.lanadesign.tech/` must not return the Bright application shell directly.
2. GitHub user `nguyentuanson27-netizen` must complete OAuth and see the Bright UI.
3. A GitHub user outside the allowlist must be denied.
4. `/health` and `/metrics` must not have a public bypass around OAuth.

CI uses dummy OAuth credentials and proves topology plus unauthenticated isolation only. Real GitHub login is a human production check.

## Live Gemini TTS and end-to-end smoke

Because Gemini TTS is Preview, do not retire the legacy stack based only on container health. Run one controlled creator project through the real workflow:

```text
create project
 -> Gemini research
 -> Gemini structured generation
 -> human review/approval
 -> media ingest
 -> Gemini TTS Preview
 -> Remotion render
 -> validated MP4 download
```

Success requires a non-empty playable voice track, valid MP4, and completed durable project state. Provider errors must remain sanitized in logs; never print the Gemini key or raw provider response.

## Rollback

Keep the legacy Bright stack and old Caddy site block during the verification window. If OAuth/UI/provider/render smoke fails:

1. restore only the previous Bright site block from the protected Caddyfile backup;
2. validate the complete Caddyfile;
3. reload Caddy;
4. confirm the legacy endpoint behaves as before;
5. leave standalone services running for diagnosis or stop them without touching shared Caddy:

```bash
docker compose stop oauth2-proxy app worker
```

Do not remove `bright-edge` while Caddy or standalone OAuth is attached. Do not remove Caddy's `n8n-bright_default` attachment until rollback is intentionally closed.

## After successful cutover

After OAuth and a real Gemini-TTS/Remotion end-to-end smoke both pass:

- retire or rotate the exposed legacy `X-Bright-Api-Key` credential;
- stop the legacy Bright API/oauth containers when rollback is no longer required;
- remove the legacy Caddy network attachment only after confirming no other service needs it;
- keep backups according to `docs/operations/storage.md`;
- keep `/metrics` private and follow `docs/operations/observability.md` for on-call checks.
