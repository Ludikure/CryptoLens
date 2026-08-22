// Policy/macro catalyst feed (2026-08-22). The plumbing is easy; the thing worth testing is the
// NOISE GATE — crypto media is mostly price recaps and op-eds, and letting those into the prompt
// next to validated pre-computed flags is how this becomes a graveyard entry rather than context.
import { describe, it, expect, afterAll } from 'vitest';
import { parseFeed, isRelevant, matchedTerms, hashId, pollNewsFeeds, fetchRecentNews, pruneIrrelevant, ensureNewsTable, type NewsFeed } from '../src/news';
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
    <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260821a.htm</link>
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
  it('keeps a Fed monetary release via its URL slug', () => {
    const [fedItem] = parseFeed(RSS, PRIMARY);
    expect(fedItem.category).toBe('monetary');
    expect(isRelevant(fedItem)).toBe(true);
  });

  it('drops an outlet price recap even though it names bitcoin — asset words are not events', () => {
    const recap = parseFeed(RSS, OUTLET)[1];
    expect(recap.title).toContain('surges past');
    expect(matchedTerms(recap)).toContain('bitcoin');   // it DOES match an asset term...
    expect(isRelevant(recap)).toBe(false);              // ...which is deliberately not enough
  });

  it('keeps an outlet story that names a real catalyst', () => {
    const [item] = parseFeed(ATOM, OUTLET);
    expect(isRelevant(item)).toBe(true);
    expect(matchedTerms(item)).toContain('etf');   // 'approves' was dropped: it matched bank-merger approvals
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
    // fed feed: the monetary release auto-passes on its slug; the "bulls take control" item is a
    // price recap with no policy word in its title, so the recap veto drops it even from a primary
    // feed. outlet feed: the Fed-worded item passes (an outlet writing ABOUT the Fed is subject
    // matter, and SELF_TERMS only suppresses that inside the Fed's own feed).
    expect(first.inserted).toBe(2);
    const blocked = first.health.find(h => h.id === 'dead')!;
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('ECONNREFUSED');
    expect(first.health.find(h => h.id === 'fed')!.kept).toBe(1);
    expect(first.health.find(h => h.id === 'ct')!.kept).toBe(1);   // the Fed story, not the price recap

    // Re-poll: same GUIDs, nothing new.
    const second = await pollNewsFeeds(env, NOW, feeds);
    expect(second.inserted).toBe(0);

    // Prompt view: primaries first, formatted with age, catalyst flagged.
    const view = (await fetchRecentNews(env, { isCrypto: true, nowMs: NOW }))!;
    expect(view.headlines.length).toBe(2);
    expect(view.headlines[0]).toContain(', official');
    expect(view.headlines[0]).toMatch(/\[Federal Reserve, official, \d+h ago\]/);
    expect(view.catalystActive).toBe(true);          // Fed release 1.5h ago
    expect(view.latestPrimaryAgeH).toBeLessThanOrEqual(2);

    // Stocks see macro scope only — crypto-outlet items are off-topic there.
    const stockView = (await fetchRecentNews(env, { isCrypto: false, nowMs: NOW }))!;
    expect(stockView.headlines.every(h => !h.includes('Cointelegraph'))).toBe(true);
    // Primaries get a 7-day window, so a release older than the 48h outlet window still shows.
    const d5 = (await fetchRecentNews(env, { isCrypto: true, nowMs: NOW + 5 * 24 * 3600_000 }))!;
    expect(d5.headlines.length).toBeGreaterThan(0);
    expect(d5.catalystActive).toBe(false);

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

// Rewritten relevance rule (2026-08-22, after the first deploy). The original "primaries pass on
// provenance alone" put a bank-merger approval and an advisory-committee ICYMI into the model's
// top-ranked slots. These are the REAL headlines that shipped — pinned so the rule can't regress.
describe('relevance rule v2 — observed noise must not pass', () => {
  const item = (title: string, source: string, category: string | null = null) => ({
    id: 'x', source, sourceName: source, title, summary: '', url: '',
    publishedAt: 0, primary: ['fed', 'sec', 'cftc'].includes(source),
    scope: 'macro' as const, category,
  });

  it('drops the exact administrative noise the first deploy surfaced', () => {
    expect(isRelevant(item('Federal Reserve Board announces approval of application by National Westminster Bank Plc', 'fed', 'orders'))).toBe(false);
    expect(isRelevant(item('ICYMI: Members of the CFTC’s Innovation Advisory Committee Join Chairman Selig in Washington at Inaugural Meeting', 'cftc'))).toBe(false);
    expect(isRelevant(item('CFTC Seeks Public Comments on Proposed Elimination of SEF Order Book Requirement for Permitted Transactions', 'cftc'))).toBe(false);
  });

  it('keeps a Fed monetary release on its URL slug, whatever the wording', () => {
    // FOMC copy is deliberately understated; a keyword gate would drop the most important releases.
    expect(isRelevant(item('Federal Reserve issues FOMC statement', 'fed', 'monetary'))).toBe(true);
    expect(isRelevant(item('Statement regarding repurchase operations', 'fed', 'monetary'))).toBe(true);
  });

  it('keeps genuine crypto and macro subjects', () => {
    expect(isRelevant(item('SEC approves spot bitcoin ETF listing standards', 'sec'))).toBe(true);
    expect(isRelevant(item('MiCA is coming for DeFi vaults, but regulation will be difficult', 'ctelegraph'))).toBe(true);
    expect(isRelevant(item('Fed signals a rate cut is on the table', 'coindesk'))).toBe(true);
  });

  it("ignores the publisher's own name as a match term in its own feed", () => {
    // "CFTC" in a CFTC headline is metadata; from an outlet it is subject matter.
    expect(matchedTerms(item('CFTC announces staff appointments', 'cftc'))).toEqual([]);
  });
});

describe('pruneIrrelevant — a rule change must clean up after itself', () => {
  const NOW2 = Date.parse('2026-08-21T16:00:00Z');
  it('deletes stored rows that the CURRENT gate rejects', async () => {
    const db = new D1Adapter(':memory:');
    const env = { DB: db } as any;
    await ensureNewsTable(env);
    // Simulate rows an older, looser rule admitted (the exact headlines that shipped).
    const rows = [
      ['a', 'fed', 'Federal Reserve', 'Federal Reserve Board announces approval of application by National Westminster Bank Plc',
       'https://www.federalreserve.gov/newsevents/pressreleases/orders20260820a.htm', 1],
      ['b', 'cftc', 'CFTC', 'ICYMI: Members of the CFTC Innovation Advisory Committee Join Chairman Selig', 'https://cftc.gov/x', 1],
      ['c', 'fed', 'Federal Reserve', 'Minutes of the Federal Open Market Committee, July 28-29, 2026',
       'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260820a.htm', 1],
    ];
    for (const [id, src, name, title, url, prim] of rows) {
      await env.DB.prepare(`INSERT INTO news_items (id, source, source_name, title, summary, url, published_at, primary_source, scope, terms, fetched_at)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, 'macro', NULL, ?)`).bind(id, src, name, title, url, NOW2 - 3600_000, prim, NOW2).run();
    }
    const pruned = await pruneIrrelevant(env, NOW2);
    expect(pruned).toBe(2);                       // the bank approval + the ICYMI
    const view = (await fetchRecentNews(env, { isCrypto: true, nowMs: NOW2 }))!;
    expect(view.headlines).toHaveLength(1);
    expect(view.headlines[0]).toContain('Minutes of the Federal Open Market Committee');
    db.close?.();
  });
});

// Vocabulary v3 (2026-08-22b), tuned against the LIVE feeds. Every headline below is real, taken
// from CoinDesk/Cointelegraph output on the day the gate was measured at ~50% precision.
describe('relevance rule v3 — measured against real crypto-outlet headlines', () => {
  const outlet = (title: string, summary = '') => ({
    id: 'x', source: 'coindesk', sourceName: 'CoinDesk', title, summary, url: '',
    publishedAt: 0, primary: false, scope: 'crypto' as const, category: null,
  });

  it('keeps the catalyst behind the Aug-2026 rally — the reason this feature exists', () => {
    expect(isRelevant(outlet('How a Treasury buyback tweak helped bitcoin surge 25% to nearly $80,000 in days'))).toBe(true);
    expect(isRelevant(outlet("Treasury's latest measure isn't QE or YCC. Still, bitcoin is skyrocketing. Here's why."))).toBe(true);
  });

  it('"treasury" in crypto media usually means a company holding BTC — that sense is voided', () => {
    expect(isRelevant(outlet('Bitcoin rally sends crypto stocks soaring as miners, treasury companies jump'))).toBe(false);
    expect(isRelevant(outlet('Strategy Bitcoin treasury hits breakeven point as BTC price passes $77K'))).toBe(false);
  });

  it('vetoes price recaps — including when a policy word appears only in the summary', () => {
    // This one shipped: it escaped the veto on a stray "treasury" in its blurb. The veto and its
    // escape are judged on the TITLE alone precisely because of it.
    expect(isRelevant(outlet('Bitcoin breaks above 200-day moving average for first time since November',
                             'Bitcoin treasury firms cheered the move'))).toBe(false);
    expect(isRelevant(outlet('Here’s what happened in crypto today', 'regulation, treasury, lawsuit'))).toBe(false);
    expect(isRelevant(outlet('Analysts split on whether Bitcoin\'s surge past key levels signals a new bull run'))).toBe(false);
  });

  it('recovers real regulatory stories the earlier vocabulary dropped', () => {
    expect(isRelevant(outlet('South Korean lawmakers seek expanded FIU powers over unregistered crypto firms'))).toBe(true);
    expect(isRelevant(outlet('Pass the Clarity Act'))).toBe(true);
    expect(isRelevant(outlet("Nomura-backed Laser Digital wins Japan's first crypto approval in four years"))).toBe(true);
    expect(isRelevant(outlet('Capital.com plans UAE spot crypto services after affiliate wins licence'))).toBe(true);
  });

  it("'approval' still does not re-admit the Fed's bank-merger boilerplate", () => {
    const fedOrder = {
      id: 'y', source: 'fed', sourceName: 'Federal Reserve', summary: '',
      title: 'Federal Reserve Board announces approval of application by National Westminster Bank Plc',
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/orders20260820a.htm',
      publishedAt: 0, primary: true, scope: 'macro' as const, category: 'orders',
    };
    expect(isRelevant(fedOrder)).toBe(false);
  });

  it('word-boundary matching: "bill" must not match "billion"', () => {
    expect(matchedTerms(outlet('Fund raises $2 billion for token launch')).includes('bill')).toBe(false);
  });
});
