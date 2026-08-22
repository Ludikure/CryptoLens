// Macro/policy catalyst feed (2026-08-22).
//
// WHY: the analysis had no narrative input for crypto at all. It could see that yields moved and
// that FOMC was Wednesday (FRED macro + the economic calendar reach both markets), but nothing
// about WHY a tape was repricing — a Treasury decision, an SEC ruling, a bill passing. Those are
// exactly the catalysts behind the Aug-2026 62k→80k run the app sat through silently.
//
// SCOPE, deliberately narrow. This is CONTEXT, not an edge:
//   - Headlines are for the LLM to read as risk framing. There is NO sentiment score, and none
//     should be added — a homemade bullish/bearish number is noise dressed as signal, and this
//     project's graveyard is full of that shape (docs/research/rejected-hypotheses.md).
//   - Nothing here feeds the ML model. The target is a 24h ATR-normalized move; headlines are
//     not a feature and were not in training.
//   - It cannot be backtested. Treat any claim that it improves outcomes as unproven.
//
// SOURCES: RSS/Atom only — feeds publishers offer FOR machine consumption. Titles + summaries
// only; article bodies are never fetched or stored (no ToS/copyright question, and the model
// only needs the headline). Weighted to PRIMARY government sources, because the catalysts that
// matter here originate there and arrive without a media outlet's framing attached.
//
// NOISE IS THE REAL RISK, not the plumbing: crypto media is mostly price recaps, sponsored
// posts and price-target op-eds, and an LLM will over-weight dramatic phrasing placed next to
// validated pre-computed flags. Hence: primaries pass on source alone, outlets must match a
// curated catalyst keyword, everything is recency-bounded, and the prompt cap is small.
//
// EGRESS: the box routes through gluetun; some publishers block VPN/datacenter IPs. Every feed
// is independently fault-isolated and its outcome logged, so a blocked source degrades to
// "that feed is missing" rather than taking the poll down. `GET /news` reports per-feed health.
//
// D1 constraint (server/d1-adapter.ts): positional `?` placeholders only, never `?N`.

export interface NewsFeed {
  id: string;
  name: string;
  url: string;
  /** Primary sources (government / regulator) pass the relevance gate on provenance alone. */
  primary: boolean;
  /** 'macro' reaches both markets; 'crypto' only reaches crypto analyses. */
  scope: 'macro' | 'crypto';
}

// Kept short on purpose. Every addition costs prompt space and raises the noise floor; a feed
// earns its slot by publishing catalysts that reprice a whole market, not company news.
export const NEWS_FEEDS: NewsFeed[] = [
  { id: 'fed',      name: 'Federal Reserve',  url: 'https://www.federalreserve.gov/feeds/press_all.xml', primary: true,  scope: 'macro' },
  { id: 'treasury', name: 'US Treasury',      url: 'https://home.treasury.gov/system/files/126/press-releases.xml', primary: true, scope: 'macro' },
  { id: 'sec',      name: 'SEC',              url: 'https://www.sec.gov/news/pressreleases.rss', primary: true,  scope: 'macro' },
  { id: 'cftc',     name: 'CFTC',             url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',   primary: true,  scope: 'macro' },
  { id: 'coindesk', name: 'CoinDesk',         url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', primary: false, scope: 'crypto' },
  { id: 'ctelegraph', name: 'Cointelegraph',  url: 'https://cointelegraph.com/rss',              primary: false, scope: 'crypto' },
];

// Catalyst vocabulary — what makes a NON-primary headline worth the prompt space. Tuned for
// "would this reprice the asset class", not "is this about crypto". Deliberately excludes
// price-move language ("surges", "plunges", "rally", "all-time high"): the tape already tells
// the model that, far more precisely than a headline can, and those words dominate the feeds.
const CATALYST_TERMS = [
  'federal reserve', 'fed ', 'fomc', 'rate cut', 'rate hike', 'interest rate', 'basis point',
  'treasury', 'bond', 'yield', 'quantitative', 'liquidity', 'debt ceiling', 'refunding',
  'sec ', 'cftc', 'regulator', 'regulation', 'legislation', 'bill', 'congress', 'senate',
  'white house', 'executive order', 'lawsuit', 'settlement', 'approval', 'approves', 'reject',
  'ban', 'legal', 'legalize', 'custody', 'stablecoin', 'etf', 'spot bitcoin', 'tariff',
  'inflation', 'cpi', 'jobs report', 'recession', 'sanction', 'seizure', 'hack', 'exploit',
];

export interface NewsItem {
  id: string;              // stable hash of guid/link — the dedupe key
  source: string;          // feed id
  sourceName: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: number;     // ms epoch
  primary: boolean;
  scope: 'macro' | 'crypto';
}

/**
 * Decode the XML/HTML entities that actually appear in feed titles.
 *
 * TWO passes, because publishers routinely DOUBLE-escape: `&amp;quot;` and `&amp;#39;` are
 * common in real feeds, and a single pass leaves a visible `&quot;` sitting in the headline the
 * model reads. `&amp;` is decoded last within each pass so an escaped entity survives to be
 * resolved by the next one. Bounded at 2 — enough for every double-escape seen in practice,
 * and it stops a headline that literally displays "&amp;quot;" from being decoded forever.
 */
function decodeOnce(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function decodeEntities(s: string): string {
  return decodeOnce(decodeOnce(s)).trim();
}

function stripTags(s: string): string {
  // CDATA must be unwrapped BEFORE tag-stripping: `<[^>]*>` eats the `<![CDATA[` opener (it runs
  // to the first `>`), which orphans the trailing `]]>` and leaves it in the headline.
  const unwrapped = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(unwrapped.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagText(block: string, ...names: string[]): string {
  for (const n of names) {
    // Attributes allowed on the open tag (Atom's <link href> / <content type>).
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) { const v = stripTags(m[1]); if (v) return v; }
  }
  return '';
}

/** Atom links carry the URL in an attribute rather than the element body. */
function atomLink(block: string): string {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return decodeEntities(alt[1]);
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return any ? decodeEntities(any[1]) : '';
}

/** Small deterministic string hash — the dedupe key, not a security primitive. */
export function hashId(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 16);
}

/**
 * Parse an RSS 2.0 or Atom document into items. Regex-based on purpose: feeds are a tiny,
 * well-behaved XML subset, and pulling in an XML parser for six URLs would add a dependency to
 * a bundle that deliberately has almost none. Malformed input yields fewer items, never a throw.
 */
export function parseFeed(xml: string, feed: NewsFeed): NewsItem[] {
  const out: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = tagText(b, 'title');
    if (!title) continue;
    const url = tagText(b, 'link') || atomLink(b);
    const summary = tagText(b, 'description', 'summary').slice(0, 400);
    const dateRaw = tagText(b, 'pubDate', 'published', 'updated', 'dc:date');
    const parsed = dateRaw ? Date.parse(dateRaw) : NaN;
    // No usable date → skip rather than guess: a wrong timestamp would let stale news present
    // itself as a live catalyst, which is worse than the item being absent.
    if (!Number.isFinite(parsed)) continue;
    const guid = tagText(b, 'guid', 'id') || url || title;
    out.push({
      id: hashId(`${feed.id}:${guid}`),
      source: feed.id, sourceName: feed.name,
      title: title.slice(0, 300), summary, url: url.slice(0, 500),
      publishedAt: parsed, primary: feed.primary, scope: feed.scope,
    });
  }
  return out;
}

/** Which catalyst terms a headline matches (empty = none). */
export function matchedTerms(item: { title: string; summary: string }): string[] {
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  return CATALYST_TERMS.filter(t => hay.includes(t));
}

/**
 * Relevance gate. Primary sources pass on provenance — a Fed or SEC press release is a catalyst
 * by definition and its headline is already plain. Outlets must name a catalyst, which is what
 * keeps "Bitcoin surges past $80K" (a recap of what the tape already shows) out of the prompt.
 */
export function isRelevant(item: NewsItem): boolean {
  return item.primary || matchedTerms(item).length > 0;
}

export async function ensureNewsTable(env: { DB: any }): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS news_items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_name TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    url TEXT,
    published_at INTEGER NOT NULL,
    primary_source INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'macro',
    terms TEXT,
    fetched_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at DESC)').run();
}

export interface FeedHealth { id: string; ok: boolean; items: number; kept: number; error?: string }

/**
 * Poll every feed, store what passes the gate. Each feed is independently isolated: a blocked
 * or malformed source costs only its own items. Returns per-feed health for `GET /news` so a
 * VPN-blocked publisher is visible rather than silently absent.
 */
export async function pollNewsFeeds(
  env: { DB: any }, nowMs: number, feeds: NewsFeed[] = NEWS_FEEDS,
): Promise<{ inserted: number; health: FeedHealth[] }> {
  await ensureNewsTable(env);
  const health: FeedHealth[] = [];
  let inserted = 0;
  const maxAge = 3 * 86400_000;   // ignore backfill on first run; only recent items are catalysts

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: {
          // SEC enforces a declared UA with contact info, and it is simply good manners
          // everywhere else. Polling is every ~15 min, well inside fair-access norms.
          'User-Agent': 'MarketScope/1.0 (+https://marketscope.ludikure.org; bmihovilovic83@gmail.com)',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        redirect: 'follow',
      });
      if (!res.ok) { health.push({ id: feed.id, ok: false, items: 0, kept: 0, error: `HTTP ${res.status}` }); continue; }
      const xml = await res.text();
      const items = parseFeed(xml, feed);
      const keep = items.filter(i => isRelevant(i) && nowMs - i.publishedAt < maxAge && i.publishedAt <= nowMs + 3600_000);
      for (const it of keep) {
        try {
          const r = await env.DB.prepare(
            `INSERT OR IGNORE INTO news_items
               (id, source, source_name, title, summary, url, published_at, primary_source, scope, terms, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(it.id, it.source, it.sourceName, it.title, it.summary, it.url, it.publishedAt,
                 it.primary ? 1 : 0, it.scope, matchedTerms(it).join(',') || null, nowMs).run();
          if ((r?.meta?.changes ?? 1) > 0) inserted++;
        } catch { /* one bad row must not abort the feed */ }
      }
      health.push({ id: feed.id, ok: true, items: items.length, kept: keep.length });
    } catch (e) {
      health.push({ id: feed.id, ok: false, items: 0, kept: 0, error: String(e).slice(0, 120) });
    }
  }
  // Retention: catalysts age out fast and this table is only ever read over a short window.
  try { await env.DB.prepare('DELETE FROM news_items WHERE published_at < ?').bind(nowMs - 14 * 86400_000).run(); } catch { /* best-effort */ }
  return { inserted, health };
}

export interface PromptNews { headlines: string[]; catalystActive: boolean; latestPrimaryAgeH: number | null }

/**
 * Read the small, recent slice the prompt gets. Stocks see MACRO primaries only — they already
 * carry Finnhub company news, and crypto-outlet items would be off-topic there.
 *
 * `catalystActive` = a PRIMARY-source item inside `catalystWindowH`. That is the flag worth
 * having: an extended move with a fresh policy catalyst behind it is a repricing, which is a
 * different animal from the exhaustion the chase guard is built to catch.
 */
export async function fetchRecentNews(
  env: { DB: any }, opts: { isCrypto: boolean; nowMs: number; lookbackH?: number; limit?: number; catalystWindowH?: number },
): Promise<PromptNews | null> {
  const lookback = (opts.lookbackH ?? 48) * 3600_000;
  const limit = opts.limit ?? 6;
  const catalystWindow = (opts.catalystWindowH ?? 12) * 3600_000;
  try {
    await ensureNewsTable(env);
    const scopeClause = opts.isCrypto ? '' : " AND scope = 'macro'";
    // Primaries first, then most recent — the cap should never be spent on outlet chatter while
    // a regulator release goes unshown.
    const res = await env.DB.prepare(
      `SELECT source_name, title, published_at, primary_source FROM news_items
        WHERE published_at > ?${scopeClause}
        ORDER BY primary_source DESC, published_at DESC LIMIT ?`
    ).bind(opts.nowMs - lookback, limit).all();
    const rows = (res.results || []) as any[];
    if (!rows.length) return null;
    const headlines = rows.map(r => {
      const ageH = Math.max(0, Math.round((opts.nowMs - r.published_at) / 3600_000));
      return `[${r.source_name}${r.primary_source ? ', official' : ''}, ${ageH}h ago] ${r.title}`;
    });
    const primaries = rows.filter(r => r.primary_source);
    const latestPrimary = primaries.length ? Math.max(...primaries.map(r => r.published_at as number)) : null;
    return {
      headlines,
      catalystActive: latestPrimary != null && opts.nowMs - latestPrimary < catalystWindow,
      latestPrimaryAgeH: latestPrimary != null ? Math.max(0, Math.round((opts.nowMs - latestPrimary) / 3600_000)) : null,
    };
  } catch { return null; }   // never fail an analysis over context
}
