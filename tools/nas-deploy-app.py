#!/usr/bin/env python3
"""Runs ON THE NAS (copied there by tools/release-box-image.sh): point the TrueNAS Custom App's
marketscope service at a locally built image and wait for it to come up healthy.

Why a script and not the Apps UI: the UI's image field pulls from a registry, and a locally
built tag has no registry copy — so setting it in the UI leaves the app with NO container (a
failed pull) and the box answering 502 until the config is repaired. The switch therefore needs
`pull_policy: never` on the service, which only the compose config carries. `midclt` is the
middleware's own CLI and needs root, hence the sudo.

Ported from the wmata-push tool (82905b9 in that repo) with one difference that matters here:
**this app has TWO services** — `marketscope` and `gluetun`, the VPN sidecar whose PROXIED_HOSTS
routing the exchange feeds depend on. The service to modify is named explicitly and every other
service is left byte-identical; gluetun in particular carries `pull_policy: None` and its own
credentials, and must not be touched.

Usage (on the NAS):  sudo -n is invoked here, not by the caller.
    python3 nas-deploy-app.py <app-name> <service-name> <image:tag> <backup-dir>
Exit status 0 only when the container is running AND healthy on the requested image.
"""
import json
import os
import subprocess
import sys
import time


def mid(*args):
    r = subprocess.run(["sudo", "-n", "midclt", "call", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"midclt failed ({' '.join(args[:2])}): {(r.stderr or r.stdout).strip()[-300:]}")
    return json.loads(r.stdout) if r.stdout.strip() else None


def container_line(app, service):
    ps = subprocess.run(["sudo", "-n", "docker", "ps", "--format", "{{.Names}}  {{.Image}}  {{.Status}}"],
                        capture_output=True, text=True).stdout
    # TrueNAS names containers ix-<app>-<service>-N; match the SERVICE, not just the app, or
    # the gluetun sidecar's line satisfies the health wait while marketscope is still down.
    want = f"ix-{app}-{service}-"
    lines = [l for l in ps.splitlines() if want in l]
    return lines[0] if lines else None


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    app, service, image, backup_dir = sys.argv[1:]
    rows = mid("app.query", json.dumps([["name", "=", app]]),
               json.dumps({"extra": {"retrieve_config": True}}))
    if not rows:
        sys.exit(f"no app named {app}")
    cfg = rows[0]["config"]
    services = cfg.get("services") or {}
    if service not in services:
        sys.exit(f"app {app} has no service named {service}; services: {list(services)}")
    svc = services[service]
    previous, prev_policy = svc.get("image"), svc.get("pull_policy")
    others = [n for n in services if n != service]
    print(f"current: {previous} (pull_policy={prev_policy}) state={rows[0].get('state')}")
    print(f"untouched services: {others or 'none'}")

    # The config carries the box's secrets (NordVPN creds, API keys): owner-only, never printed.
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(backup_dir, "app-config-backup-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
    with open(backup, "w") as f:
        json.dump(cfg, f)
    os.chmod(backup, 0o600)
    print(f"backup: {backup}")

    svc["image"] = image
    # `never` because the tag exists only on this box; `always` would try a registry pull of a
    # tag no registry has and take the app down.
    svc["pull_policy"] = "never" if "/" not in image else "always"
    mid("-j", "app.update", app, json.dumps({"custom_compose_config": cfg}))

    deadline = time.time() + 240
    line = None
    while time.time() < deadline:
        time.sleep(5)
        line = container_line(app, service)
        if line and image in line and "healthy" in line:
            print(f"container: {line}")
            return
    print(f"container after 240s: {line or '(none)'}")
    print(f"ROLLBACK: python3 {sys.argv[0]} {app} {service} {previous} {backup_dir}")
    sys.exit(1)


if __name__ == "__main__":
    main()
