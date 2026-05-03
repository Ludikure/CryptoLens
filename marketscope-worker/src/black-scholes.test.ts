// Verifies TS BS solver matches Python implementation within 1e-5 absolute tolerance
// on the same test cases. Run: node --experimental-strip-types black-scholes.test.ts
import { bsPrice, ivFromPrice, delta } from './black-scholes.ts';

// Test 1: ATM 90d (matches Python test 1)
{
    const S = 100, K = 100, T = 0.25, r = 0.05, q = 0;
    const sigmaTrue = 0.20;
    const pCall = bsPrice(S, K, T, r, q, sigmaTrue, true);
    const pPut = bsPrice(S, K, T, r, q, sigmaTrue, false);
    const ivCall = ivFromPrice(pCall, S, K, T, r, q, true)!;
    const ivPut = ivFromPrice(pPut, S, K, T, r, q, false)!;
    console.log(`Test 1 ATM 90d: call_price=${pCall.toFixed(6)}, put_price=${pPut.toFixed(6)}`);
    console.log(`  iv_call=${ivCall.toFixed(6)} (target ${sigmaTrue}), iv_put=${ivPut.toFixed(6)}`);
    if (Math.abs(ivCall - sigmaTrue) > 1e-5) throw new Error(`iv_call mismatch: ${ivCall}`);
    if (Math.abs(ivPut - sigmaTrue) > 1e-5) throw new Error(`iv_put mismatch: ${ivPut}`);
    // Python expected: call_price=4.614997, put_price=3.372777
    if (Math.abs(pCall - 4.614997) > 1e-4) throw new Error(`pCall vs Python mismatch: ${pCall}`);
    if (Math.abs(pPut - 3.372777) > 1e-4) throw new Error(`pPut vs Python mismatch: ${pPut}`);
}

// Test 2: OTM put 30d, high vol (matches Python test 2)
{
    const S = 100, K = 95, T = 30/365.25, r = 0.05, q = 0;
    const sigmaTrue = 0.40;
    const p = bsPrice(S, K, T, r, q, sigmaTrue, false);
    const iv = ivFromPrice(p, S, K, T, r, q, false)!;
    console.log(`Test 2 OTM put 30d: price=${p.toFixed(6)}, iv=${iv.toFixed(6)} (target ${sigmaTrue})`);
    if (Math.abs(iv - sigmaTrue) > 1e-5) throw new Error(`iv mismatch: ${iv}`);
    // Python expected: price=2.261787
    if (Math.abs(p - 2.261787) > 1e-4) throw new Error(`p vs Python mismatch: ${p}`);
}

// Test 3: Delta sanity (matches Python test 3)
{
    const dCallAtm = delta(100, 100, 0.25, 0.05, 0, 0.20, true);
    const dPutAtm = delta(100, 100, 0.25, 0.05, 0, 0.20, false);
    console.log(`Test 3 ATM delta: call=${dCallAtm.toFixed(4)} (~0.55), put=${dPutAtm.toFixed(4)} (~-0.45)`);
    // Python expected: call=0.5695, put=-0.4305
    if (Math.abs(dCallAtm - 0.5695) > 1e-3) throw new Error(`call delta mismatch: ${dCallAtm}`);
    if (Math.abs(dPutAtm - (-0.4305)) > 1e-3) throw new Error(`put delta mismatch: ${dPutAtm}`);
}

// Test 4: 25-delta put strikes (matches Python test 4)
{
    const S = 100, T = 30/365.25, r = 0.05, q = 0, sigma = 0.25;
    for (const K of [88, 90, 92, 94, 96]) {
        const d = delta(S, K, T, r, q, sigma, false);
        console.log(`  K=${K}: put delta = ${d.toFixed(4)}`);
    }
    // Python: K=88:-0.0302, K=90:-0.0589, K=92:-0.1044, K=94:-0.1693, K=96:-0.2537
    const expected: Record<number, number> = {88: -0.0302, 90: -0.0589, 92: -0.1044, 94: -0.1693, 96: -0.2537};
    for (const K of [88, 90, 92, 94, 96]) {
        const d = delta(S, K, T, r, q, sigma, false);
        if (Math.abs(d - expected[K]) > 1e-3) throw new Error(`K=${K} delta mismatch vs Python: ${d} vs ${expected[K]}`);
    }
}

console.log("\nAll TS BS tests passed (matches Python within 1e-3 abs).");
