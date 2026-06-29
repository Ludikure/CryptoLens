# Deploying the box (no SSH)

The self-hosted backend ("the box", `marketscope.ludikure.org` on TrueNAS) runs the image
`marketscope-worker/Dockerfile`. A GitHub Action (`.github/workflows/build-box-image.yml`) builds
that image on every push to the worker code and publishes it to **GHCR** as
`ghcr.io/ludikure/marketscope:latest`. So shipping a change is: **push → click Update in TrueNAS.**

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
