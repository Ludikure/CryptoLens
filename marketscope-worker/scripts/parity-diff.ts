#!/usr/bin/env tsx
// Diffs a Node-generated CSV against a Swift BacktestEngine CSV. Matches rows by
// timestamp (seconds-vs-ms aware), computes per-column drift metrics, and flags
// columns that diverge beyond a tolerance.
//
// Usage:
//   npm run parity -- --node /path/node.csv --swift /path/swift.csv
//   npm run parity -- ... --tolerance 1e-4 --max-show 8

import { readFile } from 'node:fs/promises';

interface Args {
    nodePath: string;
    swiftPath: string;
    tolerance: number;
    maxShow: number;
}

function parseArgs(argv: string[]): Args {
    const opts: Record<string, string> = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const k = a.slice(2);
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) opts[k] = 'true';
        else { opts[k] = v; i++; }
    }
    if (!opts.node || !opts.swift) throw new Error('Required: --node FILE --swift FILE');
    return {
        nodePath: opts.node,
        swiftPath: opts.swift,
        tolerance: parseFloat(opts.tolerance ?? '1e-4'),
        maxShow: parseInt(opts['max-show'] ?? '15', 10),
    };
}

interface ParsedCsv {
    cols: string[];
    rows: Map<number, string[]>;  // key: 4H bar timestamp in seconds (canonical)
}

async function loadCsv(path: string): Promise<ParsedCsv> {
    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    const cols = lines[0].split(',');
    const tsCol = cols.indexOf('timestamp');
    if (tsCol < 0) throw new Error(`No timestamp column in ${path}`);
    const rows = new Map<number, string[]>();
    for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].split(',');
        if (fields.length < cols.length) continue;
        const tsRaw = parseInt(fields[tsCol], 10);
        // Normalize to seconds. Swift writes seconds, Node writes ms.
        const tsSec = tsRaw > 10_000_000_000 ? Math.floor(tsRaw / 1000) : tsRaw;
        rows.set(tsSec, fields);
    }
    return { cols, rows };
}

interface ColumnStats {
    name: string;
    n: number;        // count of compared (both numeric)
    nMismatch: number;  // string mismatches
    nDrift: number;     // numeric drift > tolerance
    maxAbs: number;
    sumAbs: number;
    sample?: { ts: number; node: string; swift: string };  // first significant drift
}

function isNumeric(s: string): boolean {
    if (s === '' || s === undefined) return false;
    const n = parseFloat(s);
    return Number.isFinite(n);
}

async function main() {
    const args = parseArgs(process.argv);
    const [nodeCsv, swiftCsv] = await Promise.all([loadCsv(args.nodePath), loadCsv(args.swiftPath)]);

    // Common columns + common timestamps.
    const common = nodeCsv.cols.filter(c => swiftCsv.cols.includes(c));
    const onlyNode = nodeCsv.cols.filter(c => !swiftCsv.cols.includes(c));
    const onlySwift = swiftCsv.cols.filter(c => !nodeCsv.cols.includes(c));

    const commonTs: number[] = [];
    for (const ts of nodeCsv.rows.keys()) {
        if (swiftCsv.rows.has(ts)) commonTs.push(ts);
    }
    commonTs.sort((a, b) => a - b);

    console.log(`[parity] node=${nodeCsv.rows.size} rows, swift=${swiftCsv.rows.size} rows, common=${commonTs.length}`);
    console.log(`[parity] columns: common=${common.length}, only-node=${onlyNode.length}, only-swift=${onlySwift.length}`);
    if (onlyNode.length) console.log(`[parity] only-node: ${onlyNode.join(', ')}`);
    if (onlySwift.length) console.log(`[parity] only-swift: ${onlySwift.join(', ')}`);
    if (commonTs.length === 0) { console.error('No overlapping timestamps!'); process.exit(1); }

    const stats: ColumnStats[] = common.map(name => ({
        name, n: 0, nMismatch: 0, nDrift: 0, maxAbs: 0, sumAbs: 0,
    }));
    const nodeIdx = new Map(nodeCsv.cols.map((c, i) => [c, i] as const));
    const swiftIdx = new Map(swiftCsv.cols.map((c, i) => [c, i] as const));

    for (const ts of commonTs) {
        const nrow = nodeCsv.rows.get(ts)!;
        const srow = swiftCsv.rows.get(ts)!;
        for (let ci = 0; ci < common.length; ci++) {
            const colName = common[ci];
            const ni = nodeIdx.get(colName)!;
            const si = swiftIdx.get(colName)!;
            const nv = nrow[ni];
            const sv = srow[si];
            const stat = stats[ci];
            if (isNumeric(nv) && isNumeric(sv)) {
                const a = parseFloat(nv);
                const b = parseFloat(sv);
                const d = Math.abs(a - b);
                stat.n++;
                stat.sumAbs += d;
                if (d > stat.maxAbs) stat.maxAbs = d;
                if (d > args.tolerance) {
                    stat.nDrift++;
                    if (!stat.sample) stat.sample = { ts, node: nv, swift: sv };
                }
            } else if (nv !== sv) {
                stat.nMismatch++;
                if (!stat.sample) stat.sample = { ts, node: nv, swift: sv };
            }
        }
    }

    // Sort by drift severity: drift count first, then string mismatches, then maxAbs.
    stats.sort((a, b) => {
        const aBad = a.nDrift + a.nMismatch;
        const bBad = b.nDrift + b.nMismatch;
        if (aBad !== bBad) return bBad - aBad;
        return b.maxAbs - a.maxAbs;
    });

    const totalRows = commonTs.length;
    const cleanCols = stats.filter(s => s.nDrift === 0 && s.nMismatch === 0).length;
    console.log(`\n[parity] ${cleanCols}/${stats.length} columns clean within tol=${args.tolerance}\n`);

    console.log(['column', 'n', 'mismatch', 'drift', 'maxAbs', 'meanAbs', 'sample'].join('\t'));
    let shown = 0;
    for (const s of stats) {
        if (s.nDrift === 0 && s.nMismatch === 0) continue;
        if (shown >= args.maxShow) { console.log(`... ${stats.length - cleanCols - shown} more divergent columns suppressed`); break; }
        const sample = s.sample
            ? `node=${s.sample.node} swift=${s.sample.swift} @ts=${s.sample.ts}`
            : '';
        console.log([
            s.name.padEnd(22), s.n,
            s.nMismatch || '-',
            s.nDrift || '-',
            s.maxAbs.toExponential(2),
            (s.n > 0 ? (s.sumAbs / s.n).toExponential(2) : '-'),
            sample,
        ].join('\t'));
        shown++;
    }

    if (cleanCols === stats.length) {
        console.log(`\n[parity] ALL ${cleanCols} columns clean across ${totalRows} common rows. Nothing diverges past ${args.tolerance}.`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
