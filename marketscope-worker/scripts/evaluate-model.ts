#!/usr/bin/env tsx
// Standalone model evaluator: loads an ml-model-*.json (any version), runs it against
// CSVs produced by runBacktest.ts, reports accuracy + bucket reliability.
//
// Apples-to-apples comparison: same eval data, different model JSONs. Tells us whether
// a model regression is due to the model itself or the training data distribution.
//
// Usage:
//   npx tsx scripts/evaluate-model.ts --model /tmp/ml-model-crypto-v10.json --csvs /tmp/retrain_crypto
//
// Mirrors ml-predict.ts:evaluateTree+sigmoid+calibrate verbatim. The only thing it does
// differently is load the JSON from a path instead of via `import` (so we can swap models).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface TreeNode {
    nodeid: number;
    split?: string;
    split_condition?: number;
    yes?: number;
    no?: number;
    missing?: number;
    leaf?: number;
    children?: TreeNode[];
}

interface ModelJSON {
    trees: TreeNode[];
    base_score?: number;
    calibration?: { x: number[]; y: number[] };
}

function parseArgs(argv: string[]): { modelPath: string; csvDir: string } {
    let modelPath = '', csvDir = '';
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const v = argv[i + 1];
        if (k === '--model') { modelPath = v; i++; }
        else if (k === '--csvs') { csvDir = v; i++; }
    }
    if (!modelPath || !csvDir) {
        throw new Error('Usage: --model <path> --csvs <dir>');
    }
    return { modelPath, csvDir };
}

function evaluateTree(node: TreeNode, input: Record<string, number>): number {
    if (node.leaf !== undefined) return node.leaf;
    if (!node.split || node.split_condition === undefined) return 0;
    const val = input[node.split] ?? 0;
    const goLeft = val < node.split_condition;
    const children = node.children || [];
    const next = goLeft
        ? children.find(c => c.nodeid === node.yes)
        : children.find(c => c.nodeid === node.no);
    if (!next) return 0;
    return evaluateTree(next, input);
}

function sigmoid(x: number): number { return 1.0 / (1.0 + Math.exp(-x)); }

function calibrate(rawProb: number, cal: ModelJSON['calibration']): number {
    if (!cal || cal.x.length < 2) return rawProb;
    const { x, y } = cal;
    if (rawProb <= x[0]) return y[0];
    if (rawProb >= x[x.length - 1]) return y[y.length - 1];
    let lo = 0;
    for (let i = 1; i < x.length; i++) { if (x[i] > rawProb) { lo = i - 1; break; } }
    const t = (rawProb - x[lo]) / (x[lo + 1] - x[lo]);
    return Math.max(0, Math.min(0.85, y[lo] + t * (y[lo + 1] - y[lo])));
}

function predict(model: ModelJSON, input: Record<string, number>): number {
    const baseScore = model.base_score ?? 0.5;
    const baseLogit = Math.log(baseScore / (1 - baseScore));
    let sum = baseLogit;
    for (const tree of model.trees) sum += evaluateTree(tree, input);
    if (!isFinite(sum)) return 0.5;
    return calibrate(sigmoid(sum), model.calibration);
}

function parseCSV(content: string): { header: string[]; rows: string[][] } {
    const lines = content.split('\n').filter(l => l.length > 0);
    const header = lines[0].split(',');
    const rows = lines.slice(1).map(l => l.split(','));
    return { header, rows };
}

function rowToFeatures(header: string[], row: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < header.length; i++) {
        const k = header[i];
        const v = parseFloat(row[i]);
        if (Number.isFinite(v)) {
            // Boolean-like flags emitted by scoring-full.ts use 1/0 — already parses fine
            out[k] = v;
        }
    }
    return out;
}

function main() {
    const { modelPath, csvDir } = parseArgs(process.argv);
    const model: ModelJSON = JSON.parse(readFileSync(modelPath, 'utf8'));
    console.log(`Loaded model: ${modelPath}`);
    console.log(`  Trees: ${model.trees.length}, base_score: ${model.base_score}, calibration breakpoints: ${model.calibration?.x.length ?? 0}`);

    const files = readdirSync(csvDir).filter(f => f.endsWith('.csv'));
    console.log(`Evaluating against ${files.length} CSVs in ${csvDir}\n`);

    // Aggregates
    const buckets: Record<string, { n: number; wins: number }> = {
        '<0.30': { n: 0, wins: 0 },
        '0.30-0.50': { n: 0, wins: 0 },
        '0.50-0.60': { n: 0, wins: 0 },
        '0.60-0.70': { n: 0, wins: 0 },
        '0.70-0.85': { n: 0, wins: 0 },
    };
    let total = 0, correct = 0, totalWins = 0;
    let probSum = 0, probMax = 0;
    const probSamples: number[] = []; // For percentile

    for (const f of files) {
        const path = join(csvDir, f);
        const { header, rows } = parseCSV(readFileSync(path, 'utf8'));
        const fwdMaxFavRIdx = header.indexOf('fwdMaxFavR');
        if (fwdMaxFavRIdx < 0) {
            console.warn(`  ${f}: missing fwdMaxFavR — skipped`);
            continue;
        }
        for (const row of rows) {
            const fwdMaxFavR = parseFloat(row[fwdMaxFavRIdx]);
            if (!Number.isFinite(fwdMaxFavR)) continue;
            const goodR = fwdMaxFavR >= 1.5 ? 1 : 0;
            const features = rowToFeatures(header, row);
            const p = predict(model, features);

            total++;
            totalWins += goodR;
            probSum += p;
            if (p > probMax) probMax = p;
            probSamples.push(p);

            // Decision at 0.5 threshold (matches calibrate_v9.py walk_forward_oof line 216)
            if ((p >= 0.5 ? 1 : 0) === goodR) correct++;

            // Bucket
            let key: string;
            if (p < 0.30) key = '<0.30';
            else if (p < 0.50) key = '0.30-0.50';
            else if (p < 0.60) key = '0.50-0.60';
            else if (p < 0.70) key = '0.60-0.70';
            else key = '0.70-0.85';
            buckets[key].n++;
            buckets[key].wins += goodR;
        }
    }

    probSamples.sort((a, b) => a - b);
    const p50 = probSamples[Math.floor(probSamples.length * 0.5)];
    const p90 = probSamples[Math.floor(probSamples.length * 0.9)];

    console.log(`=== Results ===`);
    console.log(`Total bars: ${total}`);
    console.log(`Actual goodR rate: ${(totalWins / total * 100).toFixed(1)}%`);
    console.log(`Predicted probability: mean=${(probSum / total).toFixed(3)} median=${p50.toFixed(3)} p90=${p90.toFixed(3)} max=${probMax.toFixed(3)}`);
    console.log(`Accuracy @ 0.5 threshold: ${(correct / total * 100).toFixed(2)}%\n`);

    console.log(`=== Bucket reliability ===`);
    for (const [k, v] of Object.entries(buckets)) {
        const winRate = v.n > 0 ? v.wins / v.n * 100 : 0;
        console.log(`  ${k}: n=${v.n.toString().padStart(6)}, actual=${winRate.toFixed(1)}%`);
    }
}

main();
