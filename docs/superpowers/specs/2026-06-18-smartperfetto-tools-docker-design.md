# SmartPerfettoTools Docker Local Build Run Directory Design

Date: 2026-06-18

## Goal

Create an external Docker run directory at:

```text
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfettoTools
```

The directory should maintain SmartPerfetto runtime files, configuration, and persistent data while building the Docker image from the current SmartPerfetto source checkout at:

```text
/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto
```

## Context

The project README recommends Docker for normal users. Source Docker builds use the repository `Dockerfile` and serve the committed `frontend/` prebuild. Docker cannot use host Claude Code local auth, so real AI analysis needs either a UI Provider Manager profile or one explicit provider configuration in `.env`.

The external tools directory does not exist yet. It should be created without modifying the SmartPerfetto source repository's Dockerfile or default compose files.

## Chosen Approach

Use an external Compose-based run directory:

```text
SmartPerfettoTools/
├── README.md
├── compose.yml
├── .env
├── run.sh
├── rebuild.sh
├── stop.sh
├── logs.sh
├── health.sh
└── data/
    ├── uploads/
    ├── logs/
    └── provider-data/
```

`compose.yml` will build from the source checkout by using an absolute `build.context` pointing at the SmartPerfetto repository. Runtime configuration will be read from the external `.env` file. Persistent backend data will use bind mounts under `SmartPerfettoTools/data`.

## Components

### `compose.yml`

- Defines one `smartperfetto` service.
- Builds from the current source checkout:
  - context: `/mnt/media/code/cli/allTools/helptools/SmartPerfetto/SmartPerfetto`
  - dockerfile: `Dockerfile`
- Publishes backend and frontend ports using `.env` defaults:
  - backend: `SMARTPERFETTO_BACKEND_PORT`, default `3000`
  - frontend: `SMARTPERFETTO_FRONTEND_PORT`, default `10000`
- Sets production runtime environment values consistent with the repository compose files.
- Reads optional provider/runtime credentials from `.env`.
- Bind mounts:
  - `./data/uploads:/app/backend/uploads`
  - `./data/logs:/app/backend/logs`
  - `./data/provider-data:/app/backend/provider-data`
- Keeps the repository health check against `/health`.

### `.env`

- Contains safe default runtime settings only.
- Does not include real API keys.
- Documents that users should configure exactly one provider source:
  - UI Provider Manager, recommended for interactive use.
  - One uncommented env provider block for scripted/server use.

### Scripts

- `run.sh`: create data directories, build if needed, start the service, and print URLs.
- `rebuild.sh`: rebuild without cache, start the service, and print URLs.
- `stop.sh`: stop the service without deleting persistent data.
- `logs.sh`: follow container logs.
- `health.sh`: request the backend health endpoint using the configured backend port.

### `README.md`

Documents:

- Purpose of this directory.
- Commands for start, rebuild, stop, logs, and health check.
- Default URLs.
- How to change ports.
- How provider configuration works in Docker.
- What each `data/` directory stores.
- That source updates should be followed by `./rebuild.sh`.

## Data Flow

1. User runs `./run.sh` from `SmartPerfettoTools`.
2. Compose reads `SmartPerfettoTools/.env`.
3. Docker builds the image from the SmartPerfetto source checkout.
4. The container serves:
   - backend API at `http://localhost:3000` by default.
   - frontend UI at `http://localhost:10000` by default.
5. Runtime uploads, logs, and Provider Manager profiles persist in `SmartPerfettoTools/data`.

## Error Handling

- Scripts use `set -euo pipefail` so failures stop immediately.
- Scripts resolve their own directory so they can be run from any working directory.
- `run.sh` and `rebuild.sh` create required bind-mount directories before starting Compose.
- `health.sh` reports the configured health URL and relies on `curl --fail` for non-healthy responses.

## Verification

Minimum verification after implementation:

1. Check generated shell scripts with `bash -n`.
2. Check the compose config with `docker compose -f compose.yml config` from `SmartPerfettoTools`.
3. If Docker build/runtime verification is requested, run `./run.sh` and then `./health.sh`.

## Out of Scope

- Publishing a Docker Hub image.
- Modifying the repository `Dockerfile` or repository compose files.
- Changing SmartPerfetto runtime/provider behavior.
- Adding real provider API keys.
- Deleting persistent data with `docker compose down -v` or equivalent destructive commands.
