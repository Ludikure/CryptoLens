---
name: deploy
description: Build MarketScope and install on simulator, optionally bump build number and deploy worker
disable-model-invocation: true
argument-hint: [--bump] [--worker] [--testflight]
allowed-tools: Bash(xcodebuild *) Bash(xcodegen *) Bash(xcrun *) Bash(wrangler *) Bash(git *) Bash(grep *) Bash(sed *) Read Edit Glob
---

# Deploy MarketScope

Build the iOS app and install on the simulator. Optional flags:
- `--bump` — increment CURRENT_PROJECT_VERSION in project.yml before building
- `--worker` — also deploy the Cloudflare worker
- `--testflight` — bump build number (for TestFlight upload reminder)

If `$ARGUMENTS` contains `--bump` or `--testflight`, bump the build number first.

## Steps

### 1. Bump build number (if requested)

If `--bump` or `--testflight` is in `$ARGUMENTS`:
- Read `project.yml`, find `CURRENT_PROJECT_VERSION: "XX"`
- Increment by 1
- Update in place
- Run `xcodegen generate` to regenerate project

### 2. Regenerate project (if needed)

If any Swift files were added/removed since last build, or if project.yml changed:
```bash
cd /Users/bojanmihovilovic/CryptoLens && xcodegen generate
```

### 3. Build

```bash
xcodebuild -project MarketScope.xcodeproj -scheme MarketScope \
  -destination 'platform=iOS Simulator,id=F32D1D3F-AAA8-4BAC-8359-DA0CC59082CC' \
  build 2>&1 | tail -20
```

If build fails, show the errors and stop.

### 4. Install on simulator

```bash
xcodebuild -project MarketScope.xcodeproj -scheme MarketScope \
  -destination 'platform=iOS Simulator,id=F32D1D3F-AAA8-4BAC-8359-DA0CC59082CC' \
  install DSTROOT=/tmp/MarketScope.dst 2>&1 | tail -5

xcrun simctl install F32D1D3F-AAA8-4BAC-8359-DA0CC59082CC \
  /tmp/MarketScope.dst/Applications/MarketScope.app
```

### 5. Deploy worker (if requested)

If `--worker` is in `$ARGUMENTS`:
```bash
cd /Users/bojanmihovilovic/CryptoLens/marketscope-worker && wrangler deploy
```

### 6. Report

- Build number (current)
- Build result (success/fail)
- Simulator install result
- Worker deploy result (if applicable)
- If `--testflight`: remind user to archive and upload from Xcode
