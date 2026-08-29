#!/bin/bash
# Build the box image ON THE TrueNAS box and switch the app to it — no GitHub Actions, no
# manual UI click. Ported from the wmata-push tool (82905b9 in that repo) after it proved out
# there; the shape is the same, the guards are adapted to this repo.
#
# What this replaces: push -> wait for the GHCR workflow -> click Update in the TrueNAS UI.
# What it keeps from that workflow — deliberately, because the workflow's test gate exists for
# a specific reason (2026-08-26: the image job had NO test step, and that was the channel
# through which every broken prompt reached production that week):
#   - the FULL suite runs here before anything is copied, and a red suite ships nothing;
#   - it ships a COMMIT (`git archive`), never the working tree, so an unstaged file cannot
#     ride along, and the worker dir must be clean so the tests run on exactly what ships;
#   - GIT_SHA is baked in, so /health.build still proves what is actually running.
#
# What it does NOT do: push to GHCR. The image exists only on the box, tagged
# `marketscope:<short-sha>-local`, and the app is switched with `pull_policy: never` — setting
# a local-only tag while the policy is `always` makes the app try a registry pull of a tag no
# registry has, which leaves it with no container. Use --ghcr to go back to the registry copy.
#
# NOTE this app has two services: `marketscope` and the `gluetun` VPN sidecar whose
# PROXIED_HOSTS routing the Binance feeds depend on. Only the marketscope service is modified.
#
# Access it needs: SSH as ludikure@box with this Mac's key, and passwordless sudo there for
# `docker` and `midclt` (the TrueNAS middleware CLI, root-only).
#
# Usage:
#   tools/release-box-image.sh                 # build HEAD on the box + deploy
#   tools/release-box-image.sh <commit-ish>    # build that commit + deploy
#   tools/release-box-image.sh --no-deploy     # build only, leave the app running what it runs
#   tools/release-box-image.sh --ghcr          # switch back to ghcr.io/...:latest, policy always
#   tools/release-box-image.sh --skip-tests    # emergency only; prints a loud warning
set -euo pipefail

NAS="${NAS:-ludikure@192.168.50.140}"
NAS_DIR="${NAS_DIR:-/mnt/WDRED/Share/marketscope-build}"
APP="${APP:-marketscope}"
SERVICE="${SERVICE:-marketscope}"
HEALTH_URL="${HEALTH_URL:-https://marketscope.ludikure.org/health}"
KEY="$HOME/.ssh/id_ed25519"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -i "$KEY" "$NAS")

root="$(git rev-parse --show-toplevel)"; cd "$root"
commitish="HEAD"; deploy=1; run_tests=1; to_ghcr=0
for a in "$@"; do
  case "$a" in
    --no-deploy)  deploy=0 ;;
    --skip-tests) run_tests=0 ;;
    --ghcr)       to_ghcr=1 ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    -*)           echo "unknown flag: $a" >&2; exit 2 ;;
    *)            commitish="$a" ;;
  esac
done

health_build() {
  curl -s -m 15 -H 'user-agent: Mozilla/5.0 (release-box-image)' "$HEALTH_URL" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("build",""))' 2>/dev/null || true
}

# --- --ghcr: hand the app back to the registry copy ---------------------------------------
if [[ $to_ghcr -eq 1 ]]; then
  echo "== reverting $APP/$SERVICE to ghcr.io/ludikure/marketscope:latest (pull_policy always)"
  scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" tools/nas-deploy-app.py "$NAS:$NAS_DIR/nas-deploy-app.py"
  "${SSH[@]}" "mkdir -p '$NAS_DIR'; python3 '$NAS_DIR/nas-deploy-app.py' '$APP' '$SERVICE' 'ghcr.io/ludikure/marketscope:latest' '$NAS_DIR'"
  sleep 5; echo "== /health.build = $(health_build)"; exit 0
fi

sha="$(git rev-parse --verify "${commitish}^{commit}")"
short="${sha:0:12}"
image="marketscope:${short}-local"

# --- guards -------------------------------------------------------------------------------
dirty="$(git status --porcelain marketscope-worker)"
if [[ -n "$dirty" ]]; then
  echo "REFUSED: uncommitted changes under marketscope-worker — the tests below would run on a" >&2
  echo "         different tree than ships. Commit or stash first:" >&2
  echo "$dirty" >&2; exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$sha" && $run_tests -eq 1 ]]; then
  echo "REFUSED: $commitish ($short) is not HEAD; the local test run would test HEAD, not it." >&2
  echo "         Check it out first, or pass --skip-tests and accept that it is ungated." >&2
  exit 1
fi

# --- the test gate the workflow runs -------------------------------------------------------
if [[ $run_tests -eq 1 ]]; then
  echo "== tests: marketscope-worker (tsc --noEmit && vitest run)"
  (cd marketscope-worker && npm test >/tmp/ms-test.log 2>&1) \
    || { echo "REFUSED: suite is red — no image. Tail:" >&2; tail -25 /tmp/ms-test.log >&2; exit 1; }
  echo "   green ($(grep -Eo '[0-9]+ passed' /tmp/ms-test.log | tail -1))"
else
  echo "!! --skip-tests: shipping an UNGATED image. This is the exact hole the 2026-08-26"
  echo "!! workflow change closed. Use only when the suite itself is what you are debugging."
fi

# --- reachability --------------------------------------------------------------------------
"${SSH[@]}" "sudo -n docker version --format 'box docker {{.Server.Version}} {{.Server.Arch}}' && mkdir -p '$NAS_DIR'" \
  || { echo "REFUSED: cannot reach $NAS or run docker there" >&2; exit 1; }

# --- ship the COMMIT, build, smoke ---------------------------------------------------------
echo "== context: git archive $short -> $NAS:$NAS_DIR/"
git archive --format=tar "$sha" marketscope-worker | gzip \
  | "${SSH[@]}" "cat > '$NAS_DIR/$short-context.tar.gz'"
echo "== build on the box: $image"
"${SSH[@]}" "set -e; cd '$NAS_DIR'; rm -rf ctx; mkdir ctx; tar xzf '$short-context.tar.gz' -C ctx;
  cd ctx/marketscope-worker;
  sudo -n docker build -q -f Dockerfile --build-arg GIT_SHA='$sha' -t '$image' . >/dev/null;
  baked=\$(sudo -n docker run --rm --entrypoint sh '$image' -c 'echo \$GIT_SHA');
  [ \"\$baked\" = '$sha' ] || { echo \"smoke FAILED: image reports \$baked\" >&2; exit 1; };
  echo \"   built, GIT_SHA=\${baked:0:12}\";
  echo '== local images on the box (nothing prunes these):';
  sudo -n docker image ls marketscope --format '   {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}'"

if [[ $deploy -eq 0 ]]; then
  echo "== built only (--no-deploy). To switch: tools/release-box-image.sh $short"; exit 0
fi

# --- deploy + verify from OUTSIDE the box --------------------------------------------------
before="$(health_build)"
echo "== deploy: $APP/$SERVICE -> $image   (was serving ${before:0:12})"
scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" tools/nas-deploy-app.py "$NAS:$NAS_DIR/nas-deploy-app.py"
if ! "${SSH[@]}" "python3 '$NAS_DIR/nas-deploy-app.py' '$APP' '$SERVICE' '$image' '$NAS_DIR'"; then
  cat >&2 <<MSG
DEPLOY FAILED. The image is built on the box. Either retry, or revert:
  tools/release-box-image.sh --ghcr
MSG
  exit 1
fi
sleep 5
served="$(health_build)"
if [[ "$served" == "$sha" ]]; then
  echo "== live: $HEALTH_URL serves ${served:0:12}"
else
  echo "WARNING: $HEALTH_URL serves '${served:0:12}' (expected $short) — check the tunnel/app" >&2
  exit 1
fi
