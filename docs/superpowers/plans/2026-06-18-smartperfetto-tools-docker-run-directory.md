# SmartPerfettoTools Docker Run Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an external `SmartPerfettoTools` Docker run directory that locally builds SmartPerfetto from the source checkout and keeps runtime config/data outside the source repository.

**Architecture:** Create a self-contained Compose run directory at `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools`. The Compose file uses an absolute build context pointing at `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto`, while `.env`, helper scripts, and bind-mounted persistent data live in the external tools directory.

**Tech Stack:** Docker Compose, Bash, SmartPerfetto repository `Dockerfile`, bind mounts, curl health check.

---

## File Structure

Create these files outside the source repository:

- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/compose.yml` — source-build Docker Compose configuration.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/.env` — safe runtime defaults and commented provider examples.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/run.sh` — create data directories, build if needed, and start SmartPerfetto.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/rebuild.sh` — rebuild from source without Docker cache and start SmartPerfetto.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/stop.sh` — stop SmartPerfetto without deleting persistent data.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/logs.sh` — follow container logs.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/health.sh` — check backend health endpoint.
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/README.md` — usage and maintenance guide.
- Create directories:
  - `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/uploads`
  - `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/logs`
  - `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/provider-data`

Modify this source-repository file only for planning metadata already created by the brainstorming flow:

- Already created: `docs/superpowers/specs/2026-06-18-smartperfetto-tools-docker-design.md`
- Create: `docs/superpowers/plans/2026-06-18-smartperfetto-tools-docker-run-directory.md`

Do not modify the repository `Dockerfile`, `docker-compose.yml`, or `docker-compose.hub.yml`.

## Task 1: Create External Directory Skeleton

**Files:**
- Create directory: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools`
- Create directory: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/uploads`
- Create directory: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/logs`
- Create directory: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/provider-data`

- [ ] **Step 1: Create the external run directory and persistent data directories**

Run:

```bash
mkdir -p \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/uploads \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/logs \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/provider-data
```

Expected: command exits with code `0`.

- [ ] **Step 2: Verify the skeleton exists**

Run:

```bash
find /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools -maxdepth 3 -type d | sort
```

Expected output includes exactly these relevant directories:

```text
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/logs
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/provider-data
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/data/uploads
```

## Task 2: Add Compose and Environment Files

**Files:**
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/compose.yml`
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/.env`

- [ ] **Step 1: Write `compose.yml`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/compose.yml` with this exact content:

```yaml
services:
  smartperfetto:
    build:
      context: /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto
      dockerfile: Dockerfile
    ports:
      - "${SMARTPERFETTO_BACKEND_PORT:-3000}:${SMARTPERFETTO_BACKEND_PORT:-3000}"
      - "${SMARTPERFETTO_FRONTEND_PORT:-10000}:${SMARTPERFETTO_FRONTEND_PORT:-10000}"
    environment:
      - PORT=${SMARTPERFETTO_BACKEND_PORT:-3000}
      - SMARTPERFETTO_BACKEND_PORT=${SMARTPERFETTO_BACKEND_PORT:-3000}
      - SMARTPERFETTO_BACKEND_PUBLIC_PORT=${SMARTPERFETTO_BACKEND_PUBLIC_PORT:-${SMARTPERFETTO_BACKEND_PORT:-3000}}
      - SMARTPERFETTO_BACKEND_PUBLIC_URL=${SMARTPERFETTO_BACKEND_PUBLIC_URL:-}
      - SMARTPERFETTO_FRONTEND_PORT=${SMARTPERFETTO_FRONTEND_PORT:-10000}
      - SMARTPERFETTO_OUTPUT_LANGUAGE=${SMARTPERFETTO_OUTPUT_LANGUAGE:-zh-CN}
      - NODE_ENV=production
      - FRONTEND_URL=http://localhost:${SMARTPERFETTO_FRONTEND_PORT:-10000}
      - PROVIDER_DATA_DIR_OVERRIDE=/app/backend/provider-data
    env_file:
      - path: .env
        required: false
    volumes:
      - ./data/uploads:/app/backend/uploads
      - ./data/logs:/app/backend/logs
      - ./data/provider-data:/app/backend/provider-data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "curl -f \"http://localhost:$${SMARTPERFETTO_BACKEND_PORT:-$${PORT:-3000}}/health\""]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
```

- [ ] **Step 2: Write `.env`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/.env` with this exact content:

```dotenv
# SmartPerfettoTools Docker runtime configuration.
# This file is read by compose.yml in this directory.

# ---------------------------------------------------
# Server ports
# ---------------------------------------------------
SMARTPERFETTO_BACKEND_PORT=3000
SMARTPERFETTO_FRONTEND_PORT=10000
# Set this when the browser-visible backend URL differs from localhost:port,
# for example behind a reverse proxy.
# SMARTPERFETTO_BACKEND_PUBLIC_URL=http://localhost:3000

# SmartPerfetto defaults to Simplified Chinese runtime output.
# Use en if the primary users prefer English.
SMARTPERFETTO_OUTPUT_LANGUAGE=zh-CN

# ---------------------------------------------------
# Provider setup
# ---------------------------------------------------
# Docker cannot use host Claude Code local auth.
# Recommended interactive path:
#   1. Run ./run.sh.
#   2. Open http://localhost:10000.
#   3. Open AI Assistant Settings -> Providers.
#   4. Add, test, save, and activate exactly one provider.
# Provider Manager data persists in ./data/provider-data.
#
# Scripted/server path:
#   Uncomment exactly one provider block below, replace placeholders, then run
#   ./run.sh or ./rebuild.sh.

# Anthropic direct example:
# ANTHROPIC_API_KEY=your_anthropic_api_key_here
# CLAUDE_MODEL=claude-sonnet-4-6
# CLAUDE_LIGHT_MODEL=claude-haiku-4-5

# Claude/Anthropic-compatible provider example:
# ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
# ANTHROPIC_AUTH_TOKEN=your_provider_api_key_here
# CLAUDE_MODEL=deepseek-v4-pro
# CLAUDE_LIGHT_MODEL=deepseek-v4-flash

# OpenAI/OpenAI-compatible provider example:
# SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
# OPENAI_BASE_URL=https://api.deepseek.com/v1
# OPENAI_API_KEY=your_provider_api_key_here
# OPENAI_AGENTS_PROTOCOL=chat_completions
# OPENAI_MODEL=deepseek-v4-pro
# OPENAI_LIGHT_MODEL=deepseek-v4-flash
```

- [ ] **Step 3: Validate compose interpolation**

Run:

```bash
cd /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools && docker compose -f compose.yml config >/tmp/smartperfetto-tools-compose-config.txt
```

Expected: command exits with code `0`. `/tmp/smartperfetto-tools-compose-config.txt` contains a rendered `smartperfetto` service.

## Task 3: Add Management Scripts

**Files:**
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/run.sh`
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/rebuild.sh`
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/stop.sh`
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/logs.sh`
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/health.sh`

- [ ] **Step 1: Write `run.sh`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/run.sh` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data/uploads data/logs data/provider-data

docker compose -f compose.yml up -d --build

BACKEND_PORT="${SMARTPERFETTO_BACKEND_PORT:-3000}"
FRONTEND_PORT="${SMARTPERFETTO_FRONTEND_PORT:-10000}"

printf '\nSmartPerfetto is starting.\n'
printf 'Frontend:       http://localhost:%s\n' "$FRONTEND_PORT"
printf 'Backend health: http://localhost:%s/health\n' "$BACKEND_PORT"
printf '\nRun ./logs.sh to follow logs, or ./health.sh to check backend health.\n'
```

- [ ] **Step 2: Write `rebuild.sh`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/rebuild.sh` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data/uploads data/logs data/provider-data

docker compose -f compose.yml build --no-cache
docker compose -f compose.yml up -d

BACKEND_PORT="${SMARTPERFETTO_BACKEND_PORT:-3000}"
FRONTEND_PORT="${SMARTPERFETTO_FRONTEND_PORT:-10000}"

printf '\nSmartPerfetto was rebuilt and started.\n'
printf 'Frontend:       http://localhost:%s\n' "$FRONTEND_PORT"
printf 'Backend health: http://localhost:%s/health\n' "$BACKEND_PORT"
```

- [ ] **Step 3: Write `stop.sh`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/stop.sh` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

docker compose -f compose.yml down

printf '\nSmartPerfetto stopped. Persistent data remains under %s/data.\n' "$SCRIPT_DIR"
```

- [ ] **Step 4: Write `logs.sh`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/logs.sh` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

docker compose -f compose.yml logs -f smartperfetto
```

- [ ] **Step 5: Write `health.sh`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/health.sh` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BACKEND_PORT="${SMARTPERFETTO_BACKEND_PORT:-3000}"
HEALTH_URL="http://localhost:${BACKEND_PORT}/health"

printf 'Checking %s\n' "$HEALTH_URL"
curl --fail --show-error --silent "$HEALTH_URL"
printf '\n'
```

- [ ] **Step 6: Make scripts executable**

Run:

```bash
chmod +x \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/run.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/rebuild.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/stop.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/logs.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/health.sh
```

Expected: command exits with code `0`.

- [ ] **Step 7: Validate shell syntax**

Run:

```bash
bash -n \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/run.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/rebuild.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/stop.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/logs.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/health.sh
```

Expected: command exits with code `0`.

## Task 4: Add External Directory README

**Files:**
- Create: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/README.md`

- [ ] **Step 1: Write `README.md`**

Create `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/README.md` with this exact content:

```markdown
# SmartPerfettoTools Docker Run Directory

This directory runs SmartPerfetto with Docker Compose while keeping runtime configuration and persistent data outside the SmartPerfetto source repository.

## Source Checkout

The Compose file builds from this source checkout:

```text
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto
```

If that source path changes, update `compose.yml`.

## Start

```bash
./run.sh
```

Default URLs:

- Frontend: http://localhost:10000
- Backend health: http://localhost:3000/health

## Rebuild After Source Updates

Run this after pulling or editing SmartPerfetto source code:

```bash
./rebuild.sh
```

`rebuild.sh` uses `docker compose build --no-cache`, so it is slower than `run.sh`.

## Stop

```bash
./stop.sh
```

This stops the container but keeps data under `./data`.

## Logs

```bash
./logs.sh
```

## Health Check

```bash
./health.sh
```

## Ports

Edit `.env` to change ports:

```dotenv
SMARTPERFETTO_BACKEND_PORT=3000
SMARTPERFETTO_FRONTEND_PORT=10000
```

If the browser-visible backend URL differs from `localhost`, set:

```dotenv
SMARTPERFETTO_BACKEND_PUBLIC_URL=http://your-host:3000
```

## AI Provider Configuration

Docker cannot use host Claude Code local auth.

Recommended interactive setup:

1. Run `./run.sh`.
2. Open http://localhost:10000.
3. Open **AI Assistant Settings -> Providers**.
4. Add, test, save, and activate exactly one provider.

Provider Manager profiles persist in:

```text
./data/provider-data
```

For scripted/server setup, edit `.env` and uncomment exactly one provider block. Do not configure multiple provider families during first setup.

## Persistent Data

```text
./data/uploads        Uploaded traces
./data/logs           Backend logs and sessions
./data/provider-data  UI Provider Manager profiles
```

Do not delete `./data` unless you intentionally want to remove uploads, logs, and saved provider profiles.
```

- [ ] **Step 2: Check README references the correct source path**

Run:

```bash
grep -n "/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto" /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/README.md
```

Expected: command exits with code `0` and prints the source checkout path.

## Task 5: Final Verification

**Files:**
- Verify: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/compose.yml`
- Verify: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/*.sh`
- Verify: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/README.md`

- [ ] **Step 1: Validate scripts**

Run:

```bash
bash -n \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/run.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/rebuild.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/stop.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/logs.sh \
  /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools/health.sh
```

Expected: command exits with code `0`.

- [ ] **Step 2: Validate Compose config**

Run:

```bash
cd /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools && docker compose -f compose.yml config >/tmp/smartperfetto-tools-compose-config.txt
```

Expected: command exits with code `0`.

- [ ] **Step 3: Inspect rendered Compose service**

Run:

```bash
grep -nE "smartperfetto|context:|/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto|data/uploads|data/logs|data/provider-data|10000|3000" /tmp/smartperfetto-tools-compose-config.txt
```

Expected: command exits with code `0` and prints rendered service lines containing the source build context, bind mounts, and default ports.

- [ ] **Step 4: Optionally run the container**

Only run this if build/runtime verification is desired now:

```bash
cd /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools && ./run.sh
```

Expected: Docker builds the image from the SmartPerfetto source checkout and starts the service.

- [ ] **Step 5: Optionally check backend health after startup**

Only run this if Step 4 was executed and the container had time to start:

```bash
cd /mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools && ./health.sh
```

Expected: command exits with code `0` and prints backend health JSON.

## Self-Review Notes

- Spec coverage: all requested files, external run directory, local source build, bind-mounted persistent data, provider configuration notes, and verification steps are covered.
- Placeholder scan: no `TBD`, `TODO`, `implement later`, or unresolved placeholder instructions remain. Provider API key placeholders are intentionally commented examples in `.env` documentation.
- Type/name consistency: script names, service name, env variables, paths, and data directory names are consistent across compose, scripts, README, and verification commands.
