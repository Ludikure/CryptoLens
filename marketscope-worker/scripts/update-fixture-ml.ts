#!/usr/bin/env tsx
// One-off updater: re-computes expected.mlProbability for each parity fixture using
// whatever model JSONs are currently on disk in src/. Run this after retraining a
// model so the parity tests keep asserting "worker mlPredict matches what we just
// trained" rather than the old expected from v10.
//
// Usage: npx tsx scripts/update-fixture-ml.ts
//
// Reuses the worker's exported mlPredict() so the update logic is identical to the
// path the test asserts against.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mlPredict, mlPredictH72 } from '../src/ml-predict.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'test', 'fixtures', 'backtest-canonical');

function main() {
    const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
        const path = join(FIXTURE_DIR, f);
        const fixture = JSON.parse(readFileSync(path, 'utf8'));
        if (!fixture.expected || fixture.expected.mlProbability === undefined) {
            console.log(`  ${f}: no mlProbability field — skipped`);
            continue;
        }
        // Features live at expected.features (verified 2026-05-29 by inspection — not flat
        // on expected). expected itself has only { features, mlProbability }.
        const featuresInput = fixture.expected.features as Record<string, number>;
        if (!featuresInput || typeof featuresInput !== 'object') {
            console.warn(`  ${f}: expected.features missing or non-object — skipped`);
            continue;
        }
        const oldML = fixture.expected.mlProbability;
        const newML = mlPredict(featuresInput, fixture.isCrypto);
        const newMLH72 = mlPredictH72(featuresInput, fixture.isCrypto);
        const oldMLH72: number | undefined = fixture.expected.mlPersistenceProbability;
        const mlDrift = Math.abs(newML - oldML);
        const h72Drift = oldMLH72 !== undefined ? Math.abs(newMLH72 - oldMLH72) : Infinity;
        let dirty = false;
        if (mlDrift >= 1e-9) {
            fixture.expected.mlProbability = newML;
            dirty = true;
        }
        if (oldMLH72 === undefined || h72Drift >= 1e-9) {
            fixture.expected.mlPersistenceProbability = newMLH72;
            dirty = true;
        }
        if (!dirty) {
            console.log(`  ${f}: unchanged (ml=${oldML.toFixed(4)}, h72=${oldMLH72?.toFixed(4) ?? 'n/a'})`);
            continue;
        }
        writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
        const mlNote = mlDrift >= 1e-9 ? `ml ${oldML.toFixed(4)}→${newML.toFixed(4)}` : `ml ${oldML.toFixed(4)} unchanged`;
        const h72Note = oldMLH72 === undefined ? `h72 added=${newMLH72.toFixed(4)}` :
            h72Drift >= 1e-9 ? `h72 ${oldMLH72.toFixed(4)}→${newMLH72.toFixed(4)}` : `h72 ${oldMLH72.toFixed(4)} unchanged`;
        console.log(`  ${f}: ${mlNote}; ${h72Note}`);
    }
}

main();
