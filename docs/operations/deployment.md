# Standalone production deployment

## Topology

Production traffic follows one path:

```text
Internet -> Caddy :80/:443 -> oauth2-proxy :4182 -> app :4180
                                             |
                                             +-- GitHub OAuth user allowlist

backend network: oauth2-proxy -> app
                 app <-> shared data volume <-> worker
```

Only Caddy publishes host ports. `oauth2-proxy`, `app`, and `worker` stay on Compose-private networks. The worker has no public application port; its health/metrics endpoint on `4181` is internal only.

## Prerequisites

- Docker Engine with Docker Compose v2.
- A DNS name whose A/AAAA record points to the deployment host.
- Host TCP ports 80 and 443 reachable by Caddy.
- A GitHub OAuth App configured with callback URL `https://<APP_DOMAIN>/oauth2/callback`.
- An explicit comma-separated list of allowed GitHub usernames. Do not use a broad organization/domain fallback for this single-operator deployment.
- A Google TTS service-account JSON file when voice generation is enabled.
- An OpenAI API key stored in a host file readable only by the deployment operator.
- An immutable application image reference: use a git-SHA tag such as `ghcr.io/<owner>/<repo>:sha-<40-char-sha>` or an image digest. Do not deploy a floating `latest` tag.

## Secret files

Create a directory outside the repository and restrict access before writing credentials:

```bash
sudo install -d -m 0700 /srv/bright-profile/secrets
sudo sh -c 'umask 077; head -c 32 /dev/urandom > /srv/bright-profile/secrets/oauth2-proxy-cookie-secret'
```

Create these additional files with mode `0600`:

```text
/srv/bright-profile/secrets/openai-api-key
/srv/bright-profile/secrets/github-oauth-client-secret
/srv/bright-profile/secrets/google-tts.json
```

Do not place secret values in `.env`. `.env` contains only non-secret configuration and file paths to the mounted secrets.

## Environment

Copy `.env.example` to a deployment-local `.env` and set at minimum:

```text
BRIGHT_IMAGE=<immutable image tag or digest>
APP_DOMAIN=<public DNS name>
GITHUB_ALLOWED_USERS=<comma-separated exact GitHub usernames>
GITHUB_OAUTH_CLIENT_ID=<OAuth App client ID>
OPENAI_API_KEY_FILE=/srv/bright-profile/secrets/openai-api-key
GITHUB_OAUTH_CLIENT_SECRET_FILE=/srv/bright-profile/secrets/github-oauth-client-secret
OAUTH2_PROXY_COOKIE_SECRET_FILE=/srv/bright-profile/secrets/oauth2-proxy-cookie-secret
GOOGLE_TTS_CREDENTIALS_FILE=/srv/bright-profile/secrets/google-tts.json
OPENAI_RESEARCH_MODEL=<explicit dated model snapshot>
OPENAI_GENERATION_MODEL=<explicit dated model snapshot>
```

`CADDY_EDGE_IP` must be an unused address inside `BRIGHT_EDGE_SUBNET`. OAuth2 Proxy trusts only that address as the reverse proxy that may supply forwarded headers.

## Validate and build

Resolve Compose configuration before starting services:

```bash
docker compose config
```

For a source build, build the application image with the exact `BRIGHT_IMAGE` value from `.env`:

```bash
docker compose build app
```

The Dockerfile uses the checked-in lockfile and strict lifecycle-script policy. The runtime image runs as the non-root `node` user and contains the built Vite assets, Chromium, and ffmpeg required by rendering.

## Start

```bash
docker compose up -d
docker compose ps
```

Verify private service readiness from inside the Compose network/runtime:

```bash
docker compose exec -T app node -e "fetch('http://127.0.0.1:4180/health/ready').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(!b.ok)process.exit(1)})"
docker compose exec -T worker node -e "fetch('http://127.0.0.1:4181/health/ready').then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(!b.ok)process.exit(1)})"
```

The public URL must redirect an unauthenticated browser through OAuth2 Proxy rather than returning the Bright application shell directly. Complete a real GitHub OAuth login with an allowed user in staging/production before declaring authentication verified; CI uses dummy credentials and can only verify the unauthenticated boundary and proxy topology.

## Operational checks

- `docker compose port app 4180` should return no published binding.
- `docker compose port worker 4181` should return no published binding.
- `docker compose port oauth2-proxy 4182` should return no published binding.
- `docker compose port caddy 443` should return the public TLS binding.
- App and worker must both read/write the shared `bright_data` volume.
- App and worker container users must not be UID 0.
- Monitor app and worker `/metrics` endpoints through private monitoring access only; do not add public Caddy routes for them.

See `docs/operations/storage.md` for backup/cleanup and `docs/operations/observability.md` for health and metrics behavior.
