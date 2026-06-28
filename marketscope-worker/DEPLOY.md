# Deploying the box (no SSH)

The self-hosted backend ("the box", `marketscope.ludikure.org` on TrueNAS) runs the image
`marketscope-worker/Dockerfile`. A GitHub Action (`.github/workflows/build-box-image.yml`) builds
that image on every push to the worker code and publishes it to **GHCR** as
`ghcr.io/ludikure/marketscope:latest`. So shipping a change is: **push → click Update in TrueNAS.**

## One-time TrueNAS setup (do this once, ~10 min)

1. **Create a GHCR pull token** (so TrueNAS can pull the private image):
   - GitHub → Settings → Developer settings → **Personal access tokens (classic)** → Generate.
   - Scope: **`read:packages`** only. Copy the token.

2. **Give TrueNAS the credential.** In the TrueNAS UI: **Apps → Discover → (gear / three-dot) → Manage Container Images / Registries** (wording varies by version) → add a registry:
   - Registry: `ghcr.io`
   - Username: your GitHub username (`Ludikure`)
   - Password: the `read:packages` token from step 1.

3. **Point the marketscope app at the GHCR image.** Apps → Installed → `marketscope` → **Edit** → in the YAML/config change:
   ```yaml
   marketscope:
     image: ghcr.io/ludikure/marketscope:latest   # was: marketscope:1.0
   ```
   - If the UI offers an **image pull policy**, set it to **Always** (so a restart re-pulls `latest`).
   - Save. TrueNAS pulls the image and restarts the app.

   (Optional but cleaner: instead of `:latest`, pin a specific build with `:<commit-sha>` from the
   Action's output, and bump it per deploy — gives you an exact, rollback-able version.)

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
