# Deploying the box

Two paths. **The local build is the default now**; GHCR remains as the offsite, immutable copy
and the fallback.

## Path A (default) — build on the box, one command

    tools/release-box-image.sh                  # build HEAD on the box + deploy + verify
    tools/release-box-image.sh --no-deploy      # build only, leave the app running what it runs
    tools/release-box-image.sh <commit-ish>     # build a specific commit (needs --skip-tests if not HEAD)
    tools/release-box-image.sh --ghcr           # hand the app back to ghcr.io/...:latest

Ported 2026-08-28 from the wmata-push tool (`82905b9` in that repo) after it proved out there.
It runs the FULL suite locally, `git archive`s the **commit** (never the working tree) over SSH,
builds on the box as `marketscope:<short-sha>-local`, smoke-checks the baked `GIT_SHA`, switches
the app via `tools/nas-deploy-app.py` (`midclt app.update`, `pull_policy: never`, config backed
up first), waits for a healthy container, then verifies `/health.build` **from outside the box**.

**Why `pull_policy: never`:** a locally built tag has no registry copy, so `always` makes the app
attempt a pull nothing can serve and leaves it with no container. `--ghcr` restores `always`.

**This app has two services** — `marketscope` and the `gluetun` VPN sidecar whose `PROXIED_HOSTS`
routing the Binance feeds depend on. Only the marketscope service is modified; gluetun carries
its own credentials and `pull_policy: None` and is left byte-identical.

**Access it needs** (set up 2026-08-28): SSH as `ludikure@192.168.50.140` with this Mac's
`id_ed25519`, and passwordless sudo there for `docker` and `midclt` (the TrueNAS middleware CLI,
root-only). Override with `NAS=`, `NAS_DIR=`, `APP=`, `SERVICE=`, `HEALTH_URL=`.

**Known gap, stated rather than traded away:** the CI gate ran on `ubuntu-latest` (amd64); this
runs the suite on the Mac (arm64) and builds the image on the box (amd64). `better-sqlite3` is
the only native dep and it is rebuilt inside the Docker build, so exposure is small but not zero.
Closing it properly needs a test stage in the Dockerfile — the runtime image is pruned with
`npm prune --omit=dev`, so vitest is not in it.

**Disk:** ~250 MB per image on the box and nothing prunes them; the script lists what has
accumulated after every build. `sudo docker image prune` on the box when it gets silly.

## Path B — GHCR (still live, still the offsite copy)


The GitHub Action (`.github/workflows/build-box-image.yml`) still builds on every push to the
worker code and publishes `ghcr.io/ludikure/marketscope:latest` — gated on the test suite via
`needs:` since 2026-08-26. Shipping that way is **push → click Update in TrueNAS**, or
`tools/release-box-image.sh --ghcr` to switch the app back to the registry copy.

Keep it: it is the only offsite, immutable record of what shipped, and the fallback when the
box is unreachable from this Mac.

## One-time setup (done 2026-06-28 — keep for reference / re-setup)

The GHCR package is **private** (it bundles the trained ML models), so the box authenticates once:

1. **Create a GHCR pull token:** GitHub → Settings → Developer settings → **Personal access tokens
   (classic)** → scope **`read:packages`** only.
2. **Log the box in once (the only SSH step):**
   ```
   sudo docker login ghcr.io -u Ludikure
   ```
   Paste the token as the password. (Stored in `/root/.docker/config.json`; persists.)
3. **Point the marketscope app at the GHCR image.** TrueNAS UI → Apps → Installed →
   `marketscope` → **Edit** → under the `marketscope` service set (siblings, same indent):
   ```yaml
       image: ghcr.io/ludikure/marketscope:latest   # was: marketscope:1.0
       pull_policy: always
   ```
   **Save.** TrueNAS pulls the image and redeploys. (`pull_policy: always` makes every
   restart re-pull `:latest`.)

   (Optional, cleaner: pin `:<commit-sha>` instead of `:latest` and bump it per deploy for an
   exact, rollback-able version.)

## Ongoing deploys (no SSH)

1. Push your change (or it's already pushed). The Action builds + publishes the new image — watch
   it under the repo's **Actions** tab; ~2–3 min.
2. TrueNAS → Apps → `marketscope` → **Update** (if offered) or **Stop → Start** with pull policy
   Always → it pulls the new `latest` and restarts.

That's it — no SSH, no local Docker, no `docker build`.

## Fallback (the old manual way)

If GHCR/Actions is ever unavailable, the original path still works: SSH to the box,
`cd ~/marketscope-build`, refresh `src/` (scp from the Mac), `sudo docker build -t marketscope:1.0 .`,
then Stop/Start the app. (`npm run deploy` is intentionally a guard that errors — never
`wrangler deploy`; that resurrects the dead Cloudflare Worker.)
