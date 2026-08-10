# Standalone production deployment

## Topology

The production host already has a shared Caddy edge that owns ports 80/443 for multiple applications. Bright must not start a second Caddy or take ownership of those ports.

Production traffic follows one path:

```text
Internet -> shared host Caddy :80/:443
                    |
                    | dedicated external Docker network: bright-edge
                    v
        bright-standalone-oauth2-proxy :4182
                    |
                    | Bright private backend network
                    v
                 app :4180 ---- durable SQLite/data volume
                                      |
                                      +---- worker / Chromium / FFmpeg / providers
```

Bright Compose contains only `oauth2-proxy`, `app`, and `worker`. None publishes a host port. Only `oauth2-proxy` joins the dedicated external edge network and it exposes the stable network alias `bright-standalone-oauth2-proxy` for the shared Caddy. `app` and `worker` remain on the Bright backend network.

There must be no runtime dependency on an n8n-owned network. A dedicated external network such as `bright-edge` is created independently and its lifecycle is not owned by either Compose project.

Secrets follow least privilege: GitHub OAuth secrets are mounted only into `oauth2-proxy`; OpenAI and Google TTS provider credentials are mounted only into `worker`; `app` receives no provider credential because it only validates requests, serves the UI/API, and enqueues provider work.

## Prerequisites

- Docker Engine with Docker Compose v2.
- A shared Caddy container already serving host ports 80/443.
- A DNS name whose A/AAAA record points to the deployment host.
- A GitHub OAuth App configured with callback URL `https://<APP_DOMAIN>/oauth2/callback`.
- An explicit comma-separated list of allowed GitHub usernames.
- A Google TTS service-account JSON file when voice generation is enabled.
- An OpenAI API key stored in a host file under the private deployment secret directory.
- An immutable application image reference: use a git-SHA tag such as `ghcr.io/<owner>/<repo>:sha-<40-char-sha>` or an image digest. Do not deploy a floating `latest` tag.

## Secret files

Docker Compose file-backed secrets are bind mounts. For `file:` secret sources, Compose does not remap `uid`, `gid`, or `mode`; the source file permissions are what the non-root container process sees. Keep host access private with the parent directory, while making each mounted file readable inside the service container.

Create the secret directory as `0700` and make it owned by the deployment operator that runs Docker Compose:

```bash
sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /srv/bright-profile/secrets
```

Write credentials inside that directory with a restrictive umask, then set the secret files to `0444` after their contents are complete:

```bash
umask 077
head -c 32 /dev/urandom > /srv/bright-profile/secrets/oauth2-proxy-cookie-secret
# Create/populate the three files below without committing or echoing their values to logs:
# /srv/bright-profile/secrets/openai-api-key
# /srv/bright-profile/secrets/github-oauth-client-secret
# /srv/bright-profile/secrets/google-tts.json
chmod 0444 /srv/bright-profile/secrets/openai-api-key \
  /srv/bright-profile/secrets/github-oauth-client-secret \
  /srv/bright-profile/secrets/oauth2-proxy-cookie-secret \
  /srv/bright-profile/secrets/google-tts.json
```

The secret files are world-readable *by mode* so the different non-root container users can read their bind-mounted copy, but host users other than the deployment operator cannot traverse the `0700` parent directory. Do not relax the directory mode. Do not place secret values in `.env`; `.env` contains only non-secret configuration and file paths to mounted secrets.

Before starting the stack, verify the source permissions without printing secret contents:

```bash
test "$(stat -c '%a' /srv/bright-profile/secrets)" = 700
for secret in openai-api-key github-oauth-client-secret oauth2-proxy-cookie-secret google-tts.json; do
  test "$(stat -c '%a' "/srv/bright-profile/secrets/$secret")" = 444
done
```

## Environment

Copy `.env.example` to a deployment-local `.env` and set at minimum:

```text
BRIGHT_IMAGE=<immutable image tag or digest>
APP_DOMAIN=<public DNS name>
BRIGHT_EDGE_NETWORK=bright-edge
BRIGHT_EDGE_CIDR=172.31.250.0/29
GITHUB_ALLOWED_USERS=<comma-separated exact GitHub usernames>
GITHUB_OAUTH_CLIENT_ID=<OAuth App client ID>
OPENAI_API_KEY_FILE=/srv/bright-profile/secrets/openai-api-key
GITHUB_OAUTH_CLIENT_SECRET_FILE=/srv/bright-profile/secrets/github-oauth-client-secret
OAUTH2_PROXY_COOKIE_SECRET_FILE=/srv/bright-profile/secrets/oauth2-proxy-cookie-secret
GOOGLE_TTS_CREDENTIALS_FILE=/srv/bright-profile/secrets/google-tts.json
OPENAI_RESEARCH_MODEL=<explicit dated model snapshot>
OPENAI_GENERATION_MODEL=<explicit dated model snapshot>
```

`BRIGHT_EDGE_CIDR` is both the subnet used when creating the dedicated edge network and the narrow CIDR trusted by OAuth2 Proxy for reverse-proxy forwarding headers. Only the shared Caddy and Bright `oauth2-proxy` should join this network.

## Create and persist the shared edge network

Create the network once. Compose treats it as external and will fail closed if it is missing:

```bash
docker network inspect "$BRIGHT_EDGE_NETWORK" >/dev/null 2>&1 || \
  docker network create --driver bridge --subnet "$BRIGHT_EDGE_CIDR" "$BRIGHT_EDGE_NETWORK"
```

The shared Caddy must join this network. A one-time staging connection can be made with:

```bash
docker network connect "$BRIGHT_EDGE_NETWORK" <shared-caddy-container>
```

That command is not durable if the Caddy container is recreated. Persist the same external network in the Compose project that owns the shared Caddy. Merge the equivalent of this into that project's existing service/network declarations without removing its other networks:

```yaml
services:
  caddy:
    networks:
      # keep all existing networks
      - bright-edge

networks:
  bright-edge:
    external: true
    name: bright-edge
```

## Validate and build Bright

Resolve Compose configuration before starting services:

```bash
docker compose config
```

For a source build, build the application image with the exact `BRIGHT_IMAGE` value from `.env`:

```bash
docker compose build app
```

The Dockerfile uses the checked-in lockfile and strict lifecycle-script policy. The runtime image runs as the non-root `node` user and contains the built Vite assets, Chromium, and ffmpeg required by rendering.

## Start Bright without changing public traffic

The Compose project is explicitly named `bright-standalone`, so it can run alongside the legacy stack during migration.

```bash
docker compose up -d app worker oauth2-proxy
docker compose ps
```

Verify readiness inside the containers:

```bash
docker compose exec -T app node -e "fetch('http://127.0.0.1:4180/health/ready').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(!b.ok)process.exit(1)})"
docker compose exec -T worker node -e "fetch('http://127.0.0.1:4181/health/ready').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(!b.ok)process.exit(1)})"
```

All Bright service host-binding maps must remain empty:

```bash
for service in app worker oauth2-proxy; do
  container="$(docker compose ps -q "$service")"
  docker inspect --format='{{json .HostConfig.PortBindings}}' "$container"
done
```

## Shared Caddy cutover

Before editing the shared Caddy configuration, make a protected backup of its current file. Keep the legacy Bright stack running until the new OAuth flow is verified so rollback is a configuration reload rather than a rebuild.

The Bright repository `Caddyfile` is a site-block template only; Bright Compose does not mount or run it. In the host Caddyfile, the Bright site must proxy to the network alias and must not inject the legacy `X-Bright-Api-Key` header:

```caddyfile
video.example.com {
  encode gzip
  reverse_proxy bright-standalone-oauth2-proxy:4182
}
```

For the current production domain, replace `video.example.com` with the actual `APP_DOMAIN`. Remove any legacy `header_up X-Bright-Api-Key ...` directive from this site block. Do not copy the old API token into a new config, repository, command, or chat.

Validate the complete shared Caddyfile before applying it:

```bash
docker exec <shared-caddy-container> \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Then perform an API-based zero-downtime reload:

```bash
docker exec <shared-caddy-container> \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Caddy must remain the only owner of host ports 80/443. Do not stop/recreate the shared Caddy merely to switch the Bright upstream.

## Authentication verification

Before declaring authentication verified:

1. An unauthenticated request to `https://<APP_DOMAIN>/` must not return the Bright application shell directly.
2. A GitHub user in `GITHUB_ALLOWED_USERS` must complete OAuth and see the Bright UI.
3. A GitHub user outside the allowlist must be denied.
4. `/health` and `/metrics` must not be exposed through a bypass route around OAuth.

CI uses dummy OAuth credentials and can prove topology plus unauthenticated isolation only. A real GitHub OAuth browser login remains a human staging/production check.

## Current VPS migration notes

The observed production host uses a shared Caddy container and the legacy Bright stack is still connected through an n8n-owned network. Migration must create `bright-edge` independently and attach the shared Caddy to it before changing the `video.lanadesign.tech` upstream. Do not reuse the n8n-owned network as the permanent standalone edge because deleting the legacy n8n/Bright Compose project could delete that network.

Use a stable network alias (`bright-standalone-oauth2-proxy`) rather than a container IP. Docker may change container IPs when services are recreated.

## Rollback

Before cutover, keep a protected copy of the old shared-Caddy site block. If OAuth/login/UI verification fails after the reload:

1. restore only the previous Bright site block from the protected backup;
2. validate the complete Caddyfile;
3. reload Caddy;
4. confirm the legacy endpoint behaves as before;
5. leave `bright-standalone` running for diagnosis or stop it without touching the shared Caddy:

```bash
docker compose stop oauth2-proxy app worker
```

Do not remove the shared `bright-edge` network while either the shared Caddy or standalone OAuth container is attached to it.

## Operational checks

- App and worker must both read/write the shared `bright_data` volume.
- App and worker container users must not be UID 0.
- The app mount list must not contain `/run/secrets/openai_api_key` or Google TTS credentials.
- The worker mount list must contain the OpenAI and Google TTS credential files as read-only mounts.
- `oauth2-proxy` is the only Bright service on the external edge network.
- `app`, `worker`, and `oauth2-proxy` must have no host-published ports.
- Monitor app and worker `/metrics` endpoints through private monitoring access only; do not add public Caddy routes for them.

See `docs/operations/storage.md` for backup/cleanup and `docs/operations/observability.md` for health and metrics behavior.
