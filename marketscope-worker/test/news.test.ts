// Policy/macro catalyst feed (2026-08-22). The plumbing is easy; the thing worth testing is the
// NOISE GATE — crypto media is mostly price recaps and op-eds, and letting those into the prompt
// next to validated pre-computed flags is how this becomes a graveyard entry rather than context.
import { describe, it, expect, afterAll } from 'vitest';
import { parseFeed, isRelevant, matchedTerms, hashId, pollNewsFeeds, fetchRecentNews, type NewsFeed } from '../src/news';
import { D1Adapter } from '../server/d1-adapter';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeFullIndicators } from '../src/indicators-full';
import { buildUserPrompt } from '../src/prompt';

const PRIMARY: NewsFeed = { id: 'fed', name: 'Federal Reserve', url: 'x', primary: true, scope: 'macro' };
const OUTLET: NewsFeed = { id: 'ct', name: 'Cointelegraph', url: 'x', primary: false, scope: 'crypto' };

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Feed</title>
  <item>
    <title>Federal Reserve Board announces &amp;quot;interim final rule&amp;quot; on reserve balances</title>
    <link>https://example.gov/a</link>
    <description><![CDATA[<p>The Board today announced a rule affecting <b>interest</b> on reserves.</p>]]></description>
    <pubDate>Fri, 21 Aug 2026 14:30:00 GMT</pubDate>
    <guid>https://example.gov/a</guid>
  </item>
  <item>
    <title>Bitcoin surges past $80K as bulls take control</title>
    <link>https://example.com/b</link>
    <description>BTC rallied hard overnight.</description>
    <pubDate>Fri, 21 Aug 2026 15:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>SEC approves spot ETF listing standards</title>
    <link rel="alternate" href="https://example.gov/atom-1"/>
    <summary>The Commission approved the proposal.</summary>
    <updated>2026-08-21T12:00:00Z</updated>
    <id>tag:example.gov,2026:1</id>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS items, decoding entities and stripping HTML from summaries', () => {
    const items = parseFeed(RSS, PRIMARY);
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain('"interim final rule"');   // &amp;quot; → &quot; → "
    expect(items[0].title).not.toContain('&');
    expect(items[0].summary).toBe('The Board today announced a rule affecting interest on reserves.');
    expect(items[0].publishedAt).toBe(Date.parse('Fri, 21 Aug 2026 14:30:00 GMT'));
    expect(items[0].primary).toBe(true);
  });

  it('parses Atom entries, taking the URL from the link attribute', () => {
    const items = parseFeed(ATOM, PRIMARY);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://example.gov/atom-1');
    expect(items[0].title).toBe('SEC approves spot ETF listing standards');
  });

  it('skips items with no usable date rather than guessing one', () => {
    // A wrong timestamp would let stale news present itself as a live catalyst — strictly worse
    // than the item being absent, since `catalystActive` gates prompt framing.
    const noDate = `<rss><channel><item><title>Something happened</title><link>u</link></item></channel></rss>`;
    expect(parseFeed(noDate, PRIMARY)).toHaveLength(0);
  });

  it('returns [] on malformed input instead of throwing', () => {
    expect(parseFeed('<rss><channel><item><title>unclosed', PRIMARY)).toEqual([]);
    expect(parseFeed('', PRIMARY)).toEqual([]);
  });

  it('ids are stable per item and distinct across feeds', () => {
    expect(parseFeed(RSS, PRIMARY)[0].id).toBe(parseFeed(RSS, PRIMARY)[0].id);
    expect(hashId('fed:x')).not.toBe(hashId('ct:x'));
  });
});

describe('relevance gate — the noise floor', () => {
  it('keeps a primary-source release on provenance alone', () => {
    const [fedItem] = parseFeed(RSS, PRIMARY);
    expect(isRelevant(fedItem)).toBe(true);
  });

  it('drops an outlet price recap — the tape already says this, more precisely', () => {
    const recap = parseFeed(RSS, OUTLET)[1];
    expect(recap.title).toContain('surges past');
    expect(matchedTerms(recap)).toEqual([]);
    expect(isRelevant(recap)).toBe(false);
  });

  it('keeps an outlet story that names a real catalyst', () => {
    const [item] = parseFeed(ATOM, OUTLET);
    expect(isRelevant(item)).toBe(true);
    expect(matchedTerms(item)).toContain('approves');
  });
});

describe('pollNewsFeeds + fetchRecentNews (in-memory D1)', () => {
  const NOW = Date.parse('2026-08-21T16:00:00Z');
  // Restore the real fetch: a leaked stub would silently break any later network-touching test.
  const realFetch = globalThis.fetch;
  afterAll(() => { (globalThis as any).fetch = realFetch; });

  function stubFetch(bodies: Record<string, string | Error>) {
    (globalThis as any).fetch = async (u: string) => {
      const body = bodies[String(u)];
      if (body === undefined) return { ok: false, status: 404, text: async () => '' };
      if (body instanceof Error) throw body;
      return { ok: true, status: 200, text: async () => body };
    };
  }

  it('stores relevant items, dedupes re-polls, and isolates a failing feed', async () => {
    const db = new D1Adapter(':memory:');
    const env = { DB: db } as any;
    const feeds: NewsFeed[] = [
      { ...PRIMARY, url: 'https://fed.test/rss' },
      { ...OUTLET, url: 'https://outlet.test/rss' },
      { id: 'dead', name: 'Blocked', url: 'https://blocked.test/rss', primary: true, scope: 'macro' },
    ];
    stubFetch({
      'https://fed.test/rss': RSS,
      'https://outlet.test/rss': RSS,
      'https://blocked.test/rss': new Error('ECONNREFUSED (vpn blocked)'),
    });

    const first = await pollNewsFeeds(env, NOW, feeds);
    // fed: both items kept (primary passes on provenance). outlet: only the Fed-worded one.
    expect(first.inserted).toBe(3);
    const blocked = first.health.find(h => h.id === 'dead')!;
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('ECONNREFUSED');
    expect(first.health.find(h => h.id === 'fed')!.kept).toBe(2);
    expect(first.health.find(h => h.id === 'ct')!.kept).toBe(1);

    // Re-poll: same GUIDs, nothing new.
    const second = await pollNewsFeeds(env, NOW, feeds);
    expect(second.inserted).toBe(0);

    // Prompt view: primaries first, formatted with age, catalyst flagged.
    const view = (await fetchRecentNews(env, { isCrypto: true, nowMs: NOW }))!;
    expect(view.headlines.length).toBe(3);
    expect(view.headlines[0]).toContain(', official');
    expect(view.headlines[0]).toMatch(/\[Federal Reserve, official, \d+h ago\]/);
    expect(view.catalystActive).toBe(true);          // Fed release 1.5h ago
    expect(view.latestPrimaryAgeH).toBeLessThanOrEqual(2);

    // Stocks see macro scope only — crypto-outlet items are off-topic there.
    const stockView = (await fetchRecentNews(env, { isCrypto: false, nowMs: NOW }))!;
    expect(stockView.headlines.every(h => !h.includes('Cointelegraph'))).toBe(true);

    // A stale primary must not read as a live catalyst.
    const later = (await fetchRecentNews(env, { isCrypto: true, nowMs: NOW + 30 * 3600_000 }))!;
    expect(later.catalystActive).toBe(false);
    db.close?.();
  });

  it('returns null when nothing recent is stored (prompt section simply omitted)', async () => {
    const db = new D1Adapter(':memory:');
    expect(await fetchRecentNews({ DB: db } as any, { isCrypto: true, nowMs: NOW })).toBeNull();
    db.close?.();
  });
});

describe('prompt rendering — context, never a signal', () => {
  const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'));
  const nowMs = fx.fourH[fx.fourH.length - 1].time + 14400e3;
  const ind = () => {
    const a = [
      computeFullIndicators(fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as any,
      computeFullIndicators(fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as any,
      computeFullIndicators(fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as any,
    ];
    a[0].mlWinProbability = 0.80;
    return a;
  };
  const build = (news: any) => buildUserPrompt({
    symbol: 'BTCUSDT', nowMs, indicators: ind(), prevState: {}, economicEvents: [],
    calibratedMlWin: 0.80, news,
  } as any).prompt;

  it('renders headlines with an explicit not-a-signal instruction', () => {
    const p = build({ headlines: ['[Federal Reserve, official, 2h ago] Board announces rule'], catalystActive: true, latestPrimaryAgeH: 2 });
    expect(p).toContain('POLICY / MACRO HEADLINES (context, not a trade signal)');
    expect(p).toContain('Board announces rule');
    expect(p).toContain('Never raise conviction on a headline alone');
  });

  it('omits the section entirely when there is no news', () => {
    expect(build(null)).not.toContain('POLICY / MACRO HEADLINES');
  });
});
