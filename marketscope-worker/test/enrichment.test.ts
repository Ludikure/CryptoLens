import { describe, it, expect } from 'vitest';
import { parseDerivatives, analyzePositioning, computeSpotPressure } from '../src/enrichment';

// Raw Binance fapi shapes (as the /derivatives proxy returns them).
const raw = {
  premiumIndex: { lastFundingRate: '0.00062', markPrice: '64000.5', indexPrice: '63950.0' },
  fundingHistory: [{ fundingRate: '0.0005' }, { fundingRate: '0.0007' }, { fundingRate: '0.0006' }],
  openInterest: { openInterest: '50000' },
  oiHistory: [
    { sumOpenInterest: '45000' }, { sumOpenInterest: '46000' }, { sumOpenInterest: '47000' },
    { sumOpenInterest: '48000' }, { sumOpenInterest: '49000' }, { sumOpenInterest: '50000' },
  ],
  globalLS: [{ longAccount: '0.66', shortAccount: '0.34' }],   // crowded long
  topTraderLS: [{ longAccount: '0.48', shortAccount: '0.52' }],
  takerRatio: [{ buySellRatio: '1.42', buyVol: '1200', sellVol: '845' }],
};

describe('enrichment — DerivativesService + PositioningAnalyzer port', () => {
  it('parseDerivatives mirrors buildResult', () => {
    const d = parseDerivatives(raw)!;
    expect(d).not.toBeNull();
    expect(d.fundingRatePercent).toBeCloseTo(0.062, 6);          // 0.00062 * 100
    expect(d.avgFundingRate).toBeCloseTo(0.0006, 6);             // mean of 3 history rates
    expect(d.openInterestUSD).toBeCloseTo(50000 * 64000.5, 0);   // OI × markPrice
    expect(d.oiChange4h).toBeCloseTo((50000 - 49000) / 49000 * 100, 6);
    expect(d.oiChange24h).toBeCloseTo((50000 - 45000) / 45000 * 100, 6);
    expect(d.globalLongPercent).toBeCloseTo(66, 6);
    expect(d.topTraderLongPercent).toBeCloseTo(48, 6);
    expect(d.takerBuySellRatio).toBeCloseTo(1.42, 6);
    expect(d.takerBuyVolume).toBe(1200);
  });

  it('parseDerivatives returns null when premiumIndex/OI missing', () => {
    expect(parseDerivatives({ premiumIndex: null, openInterest: null })).toBeNull();
    expect(parseDerivatives({ premiumIndex: { lastFundingRate: '0.0001', markPrice: '1', indexPrice: '1' }, openInterest: null })).toBeNull();
  });

  it('analyzePositioning mirrors PositioningAnalyzer labels + signals', () => {
    const p = analyzePositioning(parseDerivatives(raw)!);
    expect(p.crowding).toBe('Crowded Long');
    expect(p.crowdingCode).toBe('crowdedLong');
    expect(p.oiTrend).toBe('Stable');                            // 4h change ~2.04% (< 3% threshold)
    expect(p.fundingSentiment).toBe('Elevated positive (longs paying)');  // 0.062 > 0.05
    expect(p.takerPressure).toBe('Strong buy pressure');         // ratio 1.42 > 1.3
    // smart money divergence: retail long (66>55) vs top traders not long (48<55) → signal present
    expect(p.signals.some(s => s.message.startsWith('Smart money divergence'))).toBe(true);
    expect(p.signals.some(s => s.message.startsWith('Aggressive buying'))).toBe(true);
  });

  it('computeSpotPressure mirrors SpotPressureAnalyzer', () => {
    // Binance kline: [openTime,o,h,l,c, volume(5), closeTime,quoteVol,trades, takerBuyBase(9), ...]
    // 4 bars, rising taker-buy share in the back half → CVD Rising, aggressive buying.
    const k = (vol: number, takerBuy: number) => [0, '0', '0', '0', '0', String(vol), 0, '0', 0, String(takerBuy), '0', '0'];
    const klines = [k(100, 45), k(100, 48), k(100, 70), k(100, 72)];  // back half much more buy-heavy
    const depth = { bids: [['100', '8']], asks: [['101', '2']] };       // bid-heavy book
    const sp = computeSpotPressure(klines, depth)!;
    expect(sp).not.toBeNull();
    expect(sp.takerBuyRatio).toBeCloseTo((45 + 48 + 70 + 72) / 400, 6);  // 0.5875
    expect(sp.takerBuyLabel).toBe('Aggressive Buying');                  // >0.55
    expect(sp.cvd24h).toBeCloseTo((45 - 55) + (48 - 52) + (70 - 30) + (72 - 28), 6);
    expect(sp.cvdTrend).toBe('Rising');                                  // secondHalf >> firstHalf*1.2
    expect(sp.bookRatio).toBeCloseTo(8 / 10, 6);                         // 0.8
    expect(sp.bookLabel).toBe('Strong Bid Support');                     // >0.6
  });
});
