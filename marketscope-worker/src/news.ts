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
  { id: 'sec',      name: 'SEC',              url: 'https://www.sec.gov/news/pressreleases.rss', primary: true,  scope: 'macro' },
  { id: 'cftc',     name: 'CFTC',             url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',   primary: true,  scope: 'macro' },
  { id: 'coindesk', name: 'CoinDesk',         url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', primary: false, scope: 'crypto' },
  { id: 'ctelegraph', name: 'Cointelegraph',  url: 'https://cointelegraph.com/rss',              primary: false, scope: 'crypto' },
];
// US Treasury was dropped 2026-08-22: no public RSS responds at any of the documented paths
// (/rss/press.xml, /news/press-releases/feed, /system/files/126/press-releases.xml all 302 to an
// empty body or fail outright). A permanently-red feed is worse than an absent one — it trains you
// to ignore the health output. Fed `monetary` covers the rate channel; revisit if Treasury ever
// publishes a working feed.

// Catalyst vocabulary, REWRITTEN 2026-08-22 after seeing what the first cut actually surfaced.
//
// The original rule — "primary sources pass on provenance alone, a Fed release is a catalyst by
// definition" — was WRONG, and the live output proved it within a minute of deploy: the top three
// slots went to "approval of application by National Westminster Bank Plc", an "ICYMI" advisory-
// committee photo-op, and a SEF order-book comment request. The backfill had already said as much
// and I did not act on it: across 2020-2026 the Fed published 301 bcreg + 214 enforcement + 180
// other + 114 orders items against only 177 monetary. Provenance says an item is AUTHORITATIVE, not
// that it moves a market.
//
// The rule now: an item must be ABOUT something that reprices an asset class. Two vocabularies,
// deliberately narrow, and no weak modifiers ("approval", "lawsuit", "regulation" on their own
// matched bank-merger approvals). Agency self-names are excluded per-feed — "CFTC" in a CFTC
// headline is metadata, not subject matter, though "Fed signals rate cut" from an OUTLET is real.
// TWO vocabularies, because the two source classes need DIFFERENT questions asked of them.
//
// For a regulator, the question is "is this about markets at all?" — most of what the Fed and CFTC
// publish is bank supervision and committee administration. Asset words answer that well.
//
// For a crypto outlet the question is the opposite: EVERY headline says "bitcoin", so asset words
// answer nothing. The question there is "is this an event, or a recap of the price move the tape
// already shows me?" — which only event words answer. Using one shared vocabulary made the outlet
// gate WEAKER (it re-admitted "Bitcoin surges past $80K"), which the tests caught before deploy.
const ASSET_TERMS = [
  'bitcoin', 'btc', 'ethereum', 'crypto', 'digital asset', 'blockchain', 'token',
  'defi', 'web3', 'stablecoin', 'coinbase', 'binance',
];
const EVENT_TERMS = [
  // macro policy
  'fomc', 'monetary policy', 'interest rate', 'rate cut', 'rate hike', 'basis point',
  'inflation', 'cpi', 'jobs report', 'unemployment', 'yield', 'treasury', 'quantitative',
  'debt ceiling', 'refunding', 'tariff', 'recession', 'sanction', 'liquidity',
  // rulemaking / legal / regulator (agency names count as SUBJECT for an outlet; SELF_TERMS
  // removes them for the agency's own feed, where they are only metadata)
  'legislation', 'regulation', 'regulator', 'mica', 'etf', 'ban ', 'banned', 'lawsuit',
  'settlement', 'indict', 'custody rule', 'federal reserve', 'fed ', 'sec ', 'cftc',
  // security events that genuinely reprice a token
  'exploit', 'hack', 'seizure',
];
const CATALYST_TERMS = [...ASSET_TERMS, ...EVENT_TERMS];
/** Terms that are merely the publisher's own name in its own feed — never subject matter there. */
const SELF_TERMS: Record<string, string[]> = {
  fed: ['federal reserve', 'fed '], sec: ['sec '], cftc: ['cftc'],
};

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
  /** Fed release category from the URL slug (monetary | orders | bcreg | enforcement | other). */
  category?: string | null;
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
    // Fed release URLs encode the category (`.../pressreleases/monetary20241203a.htm`). That slug
    // is the authoritative separator between the rate channel and bank supervision — far better
    // than any keyword guess, and it is free.
    const catM = url.match(/\/pressreleases\/([a-z]+)\d{8}[a-z]?\.htm/i);
    out.push({
      id: hashId(`${feed.id}:${guid}`),
      source: feed.id, sourceName: feed.name,
      title: title.slice(0, 300), summary, url: url.slice(0, 500),
      publishedAt: parsed, primary: feed.primary, scope: feed.scope,
      category: catM ? catM[1].toLowerCase() : null,
    });
  }
  return out;
}

/** Which catalyst terms a headline matches, ignoring the publisher's own name in its own feed. */
export function matchedTerms(item: { title: string; summary: string; source?: string }): string[] {
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  const self = SELF_TERMS[item.source ?? ''] ?? [];
  return CATALYST_TERMS.filter(t => !self.includes(t) && hay.includes(t));
}

/**
 * Relevance gate. An item must be ABOUT something that reprices an asset class:
 *
 *  - Fed `monetary` releases auto-pass — that slug IS the rate channel (FOMC statements,
 *    implementation notes, minutes), and its wording is deliberately understated, so a keyword
 *    gate would drop exactly the releases that matter most.
 *  - Other PRIMARY releases need an asset or event subject. This replaced a blanket provenance
 *    pass on 2026-08-22, after the deployed version put a bank-merger approval and an
 *    advisory-committee "ICYMI" in the model's top-ranked slots.
 *  - OUTLET stories need an EVENT subject specifically. An asset name is not enough there: every
 *    crypto headline contains one, so accepting them re-admits exactly the price recaps this gate
 *    exists to exclude — and the tape already reports price far better than a headline can.
 */
export function isRelevant(item: NewsItem): boolean {
  if (item.source === 'fed' && item.category === 'monetary') return true;
  const terms = matchedTerms(item);
  if (!terms.length) return false;
  return item.primary || terms.some(t => EVENT_TERMS.includes(t));
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
  const maxAge = 14 * 86400_000;  // storage window. SEC publishes every few days, so a 3-day cap
                                // silently discarded EVERY SEC release (observed live: 25 parsed, 0 kept).
                                // What the PROMPT shows is bounded separately in fetchRecentNews.

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
  env: { DB: any }, opts: { isCrypto: boolean; nowMs: number; lookbackH?: number; primaryLookbackH?: number; limit?: number; catalystWindowH?: number },
): Promise<PromptNews | null> {
  const lookback = (opts.lookbackH ?? 48) * 3600_000;
  const primaryLookback = (opts.primaryLookbackH ?? 24 * 7) * 3600_000;
  const limit = opts.limit ?? 6;
  const catalystWindow = (opts.catalystWindowH ?? 12) * 3600_000;
  try {
    await ensureNewsTable(env);
    const scopeClause = opts.isCrypto ? '' : " AND scope = 'macro'";
    // Split recency: primaries get a longer window than outlets. A regulator publishes every few
    // days and a major ruling is still the reason a tape is behaving three days later, whereas
    // outlet copy goes stale fast and is the noisier half. One shared 48h window meant every SEC
    // release aged out before it could ever be shown.
    // Primaries first, then most recent — the cap should never be spent on outlet chatter while
    // a regulator release goes unshown.
    const res = await env.DB.prepare(
      `SELECT source_name, title, published_at, primary_source FROM news_items
        WHERE ((primary_source = 1 AND published_at > ?) OR (primary_source = 0 AND published_at > ?))
              ${scopeClause}
        ORDER BY primary_source DESC, published_at DESC LIMIT ?`
    ).bind(opts.nowMs - primaryLookback, opts.nowMs - lookback, limit).all();
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
