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
  /** 'rss' (default) parses XML; 'binanceCms' parses Binance's announcement JSON. */
  kind?: 'rss' | 'binanceCms';
}

// Kept short on purpose. Every addition costs prompt space and raises the noise floor; a feed
// earns its slot by publishing catalysts that reprice a whole market, not company news.
export const NEWS_FEEDS: NewsFeed[] = [
  { id: 'fed',      name: 'Federal Reserve',  url: 'https://www.federalreserve.gov/feeds/press_all.xml', primary: true,  scope: 'macro' },
  { id: 'sec',      name: 'SEC',              url: 'https://www.sec.gov/news/pressreleases.rss', primary: true,  scope: 'macro' },
  { id: 'cftc',     name: 'CFTC',             url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',   primary: true,  scope: 'macro' },
  // Federal Register — the OFFICIAL record of US rulemaking across every agency (SEC, CFTC,
  // Treasury, OCC, FinCEN) in one queryable feed. Filtered AT THE SOURCE by search term rather
  // than keyword-gated afterwards, which is a categorically cleaner input than an outlet feed.
  // It also recovers the Treasury gap indirectly: Treasury has no working RSS of its own (both
  // documented paths fail), but Treasury rulemaking publishes here — and a Treasury action is
  // what actually moved the tape in the Aug-2026 run. `conditions[term]` is the tuning knob.
  { id: 'fedreg', name: 'Federal Register', url: 'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=digital+asset&order=newest', primary: true, scope: 'macro' },
  // whitehouse.gov/presidential-actions was TRIED and dropped (2026-08-23): it kept "Nominations
  // Sent to the Senate" twice — the same administrative noise stripped out of the Fed feed — and it
  // is redundant, because presidential documents publish IN the Federal Register (verified: a
  // "digital asset" query returns 30 presidential docs incl. crypto/fintech EOs). So crypto EOs
  // arrive through the feed above, already filtered at the source.
  // Binance exchange announcements — categorically different from every other feed here. Fed
  // minutes describe the backdrop; these are facts about the INSTRUMENT being traded: a delisting
  // removes the symbol, a funding-rate change alters carry, a tick-size change alters execution,
  // and a hard fork halts the wallet. Found 2026-08-23 to be surfacing "Binance Will Delist ICX,
  // SCRT, STORJ" while ICX and STORJ were both live in ARCHIVE_CRYPTO — nothing else in the stack
  // would have said so.
  //
  // The public announcements PAGE sits behind a Cloudflare challenge, but the CMS API behind it
  // answers plainly (HTTP 200, clean JSON, no proxy needed even from a geoblocked IP). No VPN
  // required — the challenge page is not the only door.
  { id: 'binance', name: 'Binance', kind: 'binanceCms', scope: 'crypto', primary: true,
    url: 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20' },
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
// already shows me?" — which only event words answer.
//
// Matching is WORD-BOUNDARY, not substring (2026-08-22b). Substring matching forced hacks like
// 'sec ' and 'ban ' with trailing spaces, silently failed at end-of-title, and would have matched
// "bill" inside "billion". A \b…\b regex handles all of it correctly.
const ASSET_TERMS = [
  'bitcoin', 'btc', 'ethereum', 'crypto', 'digital asset', 'blockchain', 'token',
  'defi', 'web3', 'stablecoin', 'coinbase', 'binance',
];
// POLICY = the subset that denotes an actual policy/legal action. Doubles as the ESCAPE from the
// recap veto below: a price-recap headline that ALSO names a policy action is real news.
const POLICY_TERMS = [
  // macro
  'fomc', 'monetary policy', 'interest rate', 'rate cut', 'rate hike', 'basis point',
  'inflation', 'cpi', 'jobs report', 'unemployment', 'yield', 'quantitative', 'debt ceiling',
  'refunding', 'tariff', 'recession', 'sanction', 'sanctions', 'treasury',
  // legal / legislative / regulator. Added 2026-08-22b after the live gate DROPPED real stories:
  // "South Korean lawmakers seek expanded FIU powers over unregistered crypto firms" and
  // "Pass the Clarity Act" both failed for want of this vocabulary.
  'legislation', 'legislative', 'regulation', 'regulations', 'regulator', 'regulatory', 'mica',
  'ban', 'banned', 'lawsuit', 'sued', 'sues', 'court', 'judge', 'settlement', 'indict', 'indicted',
  'subpoena', 'tax', 'taxes', 'license', 'licence', 'lawmaker', 'lawmakers', 'parliament',
  // 'congress'/'senate' were REMOVED 2026-08-23: as bare terms they admitted routine
  // "Nominations Sent to the Senate" procedural items. Crypto legislation still matches via
  // legislation / regulation / lawmaker / clarity act, all of which carry subject matter.
  'clarity act', 'executive order', 'federal reserve', 'fed', 'sec', 'cftc',
  'approval', 'approves',
];
// Event-but-not-policy: real happenings that reprice a token without being a policy action.
const OTHER_EVENT_TERMS = ['etf', 'exploit', 'hack', 'hacked', 'seizure', 'custody rule'];
const EVENT_TERMS = [...POLICY_TERMS, ...OTHER_EVENT_TERMS];
const CATALYST_TERMS = [...ASSET_TERMS, ...EVENT_TERMS];

/**
 * Terms whose match is VOIDED by a nearby phrase, because the same word means something else in
 * this corpus. "Treasury" is the big one: in crypto media it usually means a COMPANY holding
 * bitcoin, not the US department — observed live admitting "crypto stocks soaring as miners,
 * treasury companies jump" and "Strategy Bitcoin treasury hits breakeven" on a word that exists
 * here to catch bond policy. The voiding phrases are deliberately narrow so the genuine articles
 * ("How a Treasury buyback tweak helped bitcoin surge...", "Treasury's latest measure isn't QE")
 * still match.
 */
const VOID_CONTEXT: Record<string, string[]> = {
  // "approval" recovers real licensing news ("Japan's first crypto exchange approval in four
  // years") but is also the Fed's standard bank-merger boilerplate — void it on that phrasing.
  approval: ['approval of application', 'bank holding compan', 'merger application'],
  treasury: ['treasury compan', 'bitcoin treasury', 'crypto treasury', 'treasury holding',
             'digital asset treasury', 'treasury firm', 'treasury strategy', 'treasury reserve'],
};

/**
 * Price-recap shapes. These VETO an item unless it also names a POLICY action — the tape reports
 * price far better than a headline can, and "Bitcoin breaks above its 200-day moving average" is
 * something this app computes itself, from the actual candles, more accurately.
 */
const RECAP_PATTERNS = [
  'live updates', 'what happened in crypto', 'moving average', 'analysts split', 'price prediction',
  'year-end call', 'bears get', 'bulls take', 'altcoin season', 'best week', 'buzz',
];

/** Terms that are merely the publisher's own name in its own feed — never subject matter there. */
const SELF_TERMS: Record<string, string[]> = {
  fed: ['federal reserve', 'fed'], sec: ['sec'], cftc: ['cftc'],
  // Federal Register prints agency names constantly as metadata; White House likewise.
  fedreg: ['federal reserve', 'sec', 'cftc'],
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

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Word-boundary matchers, built once at module load rather than per item. */
const TERM_RE: Record<string, RegExp> = Object.fromEntries(
  CATALYST_TERMS.map(t => [t, new RegExp(`\\b${escapeRe(t)}\\b`, 'i')]));

/** Which catalyst terms a headline matches, ignoring self-names and context-voided senses. */
/**
 * Binance's announcement CMS. Only the catalogs that describe INSTRUMENT changes are taken —
 * Activities and Airdrop are marketing and would swamp the cap.
 */
const BINANCE_CATALOGS = new Set([48, 49, 157, 161]);   // Listing, News, Maintenance, Delisting

export function parseBinanceCms(body: string, feed: NewsFeed): NewsItem[] {
  const out: NewsItem[] = [];
  let doc: any;
  try { doc = JSON.parse(body); } catch { return out; }
  for (const cat of doc?.data?.catalogs ?? []) {
    if (!BINANCE_CATALOGS.has(Number(cat?.catalogId))) continue;
    for (const a of cat?.articles ?? []) {
      const title = String(a?.title ?? '').trim();
      const ts = Number(a?.releaseDate);
      if (!title || !Number.isFinite(ts)) continue;
      out.push({
        id: hashId(`binance:${a?.code ?? a?.id ?? title}`),
        source: feed.id, sourceName: feed.name,
        title: title.slice(0, 300),
        // The catalog name IS the classification — carry it so the relevance gate and the prompt
        // both see "Delisting" rather than having to infer it from the wording.
        summary: String(cat?.catalogName ?? '').slice(0, 120),
        url: a?.code ? `https://www.binance.com/en/support/announcement/${a.code}` : '',
        publishedAt: ts, primary: feed.primary, scope: feed.scope, category: 'exchange',
      });
    }
  }
  return out;
}

export function matchedTerms(item: { title: string; summary: string; source?: string }): string[] {
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  const self = SELF_TERMS[item.source ?? ''] ?? [];
  return CATALYST_TERMS.filter(t => {
    if (self.includes(t)) return false;
    if (!TERM_RE[t].test(hay)) return false;
    const voids = VOID_CONTEXT[t];
    return !(voids && voids.some(v => hay.includes(v)));
  });
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
 *  - OUTLET stories need an EVENT subject specifically. An asset name is not enough: every crypto
 *    headline has one, so accepting them re-admits the price recaps this gate exists to exclude.
 *  - A recap-shaped headline is vetoed unless it names a POLICY action — which is what keeps
 *    "Treasury buyback tweak helped bitcoin surge 25%" while dropping "Bitcoin breaks above its
 *    200-day moving average".
 */
export function isRelevant(item: NewsItem): boolean {
  if (item.source === 'fed' && item.category === 'monetary') return true;
  // Exchange actions pass on provenance: a delisting, funding-rate change, tick-size update or
  // hard fork is a fact ABOUT the tradeable instrument, not commentary about the market. The
  // catalog filter upstream already excluded marketing.
  if (item.category === 'exchange') return true;
  const terms = matchedTerms(item);
  if (!terms.length) return false;
  // The recap veto and its policy escape are judged on the TITLE ALONE. Summaries are teasers and
  // digests — matching them let "Bitcoin breaks above 200-day moving average" and "Here's what
  // happened in crypto today" escape the veto on a stray "treasury" in the blurb. The title is what
  // the story is ABOUT; the summary is kept for display, not for deciding.
  const titleOnly = { title: item.title, summary: '', source: item.source };
  const titleTerms = matchedTerms(titleOnly);
  const t = item.title.toLowerCase();
  if (RECAP_PATTERNS.some(r => t.includes(r)) && !titleTerms.some(x => POLICY_TERMS.includes(x))) return false;
  return item.primary || terms.some(x => EVENT_TERMS.includes(x));
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
): Promise<{ inserted: number; pruned: number; health: FeedHealth[] }> {
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
      const body = await res.text();
      const items = feed.kind === 'binanceCms' ? parseBinanceCms(body, feed) : parseFeed(body, feed);
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
  const pruned = await pruneIrrelevant(env, nowMs);
  return { inserted, pruned, health };
}

/**
 * Re-apply the CURRENT relevance gate to everything already stored, deleting what no longer
 * qualifies.
 *
 * Why this exists: the gate used to run at INGESTION only, so tightening it did nothing to rows an
 * older, looser rule had already admitted — they sat in the table for the full 14-day retention and
 * kept appearing in the prompt. Observed exactly that on 2026-08-22: the ingestion counts dropped to
 * 1-of-20 immediately after deploy while the prompt still showed the same bank-merger and ICYMI
 * headlines from the previous rule. A write-time-only filter silently makes every future rule change
 * take two weeks to take effect.
 *
 * The Fed category isn't a stored column, but the release URL is — and the slug lives in the URL, so
 * the full gate is reconstructible from what we keep. Self-healing: any later vocabulary edit takes
 * effect on the next poll rather than on the next retention cycle.
 */
export async function pruneIrrelevant(env: { DB: any }, nowMs: number): Promise<number> {
  try {
    const res = await env.DB.prepare(
      'SELECT id, source, source_name, title, summary, url, published_at, primary_source, scope FROM news_items'
    ).all();
    const rows = (res.results || []) as any[];
    const doomed: string[] = [];
    for (const r of rows) {
      const catM = String(r.url || '').match(/\/pressreleases\/([a-z]+)\d{8}[a-z]?\.htm/i);
      const item: NewsItem = {
        id: r.id, source: r.source, sourceName: r.source_name, title: r.title || '',
        summary: r.summary || '', url: r.url || '', publishedAt: r.published_at,
        primary: !!r.primary_source, scope: (r.scope === 'crypto' ? 'crypto' : 'macro'),
        category: catM ? catM[1].toLowerCase() : null,
      };
      if (!isRelevant(item)) doomed.push(r.id);
    }
    for (const id of doomed) {
      try { await env.DB.prepare('DELETE FROM news_items WHERE id = ?').bind(id).run(); } catch { /* skip */ }
    }
    return doomed.length;
  } catch { return 0; }
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
  env: { DB: any }, opts: { isCrypto: boolean; nowMs: number; symbol?: string; lookbackH?: number; primaryLookbackH?: number; limit?: number; catalystWindowH?: number },
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
    // Over-fetch, then rank in JS. Binance publishes ~80 relevant items at a time, so a plain
    // "primaries first, newest first" ordering would let routine listing announcements crowd out
    // both the FOMC minutes and the delisting notice that actually matters.
    const res = await env.DB.prepare(
      `SELECT source, source_name, title, published_at, primary_source FROM news_items
        WHERE ((primary_source = 1 AND published_at > ?) OR (primary_source = 0 AND published_at > ?))
              ${scopeClause}
        ORDER BY published_at DESC LIMIT 200`
    ).bind(opts.nowMs - primaryLookback, opts.nowMs - lookback).all();
    let rows = (res.results || []) as any[];
    if (!rows.length) return null;

    // Base asset of the symbol under analysis: BTCUSDT -> BTC. Exchange notices are the one source
    // that is PER-INSTRUMENT, so "Binance Will Delist ICX" must reach the ICX analysis and must not
    // clutter BTC's.
    const base = (opts.symbol ?? '').replace(/USDT$|USD$|PERP$/i, '').toUpperCase();
    const mentions = (t: string) => base.length >= 2 && new RegExp(`\\b${base}\\b`, 'i').test(t);
    const isExchange = (r: any) => r.source === 'binance';
    // A notice naming no instrument at all (tick-size sweeps, API changes) is market-wide and stays.
    //
    // FIXED 2026-08-26. This required a specific VERB after the ticker
    // (`delist|launch|remov|add|monitor`), so it only recognised listing- and delisting-shaped
    // titles. Everything else naming another instrument sailed through as "market-wide" and landed
    // on every analysis. Observed on a live BTC screen, all three kept:
    //
    //   "Binance Will Support the Corning Incorporated (GLW) and Goldman Sachs Group (GS) Cash
    //    Dividend Distribution via bStocks"        -> verb is "Support", not in the list
    //   "Wallet Maintenance for Ethereum Network (ETH) - 2026-08-27"  -> verb is "Maintenance"
    //   "Binance Earn Yield Arena: Earn Up to $5,888 Rewards..."      -> pure marketing, no verb
    //
    // Binance writes instruments as a PARENTHESISED TICKER, which is the reliable signal and needs
    // no verb vocabulary to keep current. A bare uppercase run is not enough on its own — titles are
    // full of "API", "USD", "NEW" — so it must look like a ticker in brackets or carry a USDT/USD
    // pair suffix.
    const TICKER_IN_PARENS = /\(([A-Z0-9]{2,10})\)/g;
    const PAIR_TOKEN = /\b([A-Z0-9]{2,10})(?:USDT|USD)\b/g;
    const namedInstruments = (t: string): string[] => {
      const found: string[] = [];
      for (const re of [TICKER_IN_PARENS, PAIR_TOKEN]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) !== null) found.push(m[1].toUpperCase());
      }
      return found;
    };
    // Exchange MARKETING. The catalog filter excludes the Activities and Airdrop catalogs, but promos
    // also appear under News and Maintenance, so provenance alone does not keep them out. These are
    // never facts about a tradeable instrument.
    const PROMO = /\b(earn|rewards?|airdrop|giveaway|campaign|promotion|bonus|yield arena|celebrat|carnival|contest|sweepstake)\b/i;

    rows = rows.filter(r => {
      if (!isExchange(r)) return true;
      const t = String(r.title);
      if (PROMO.test(t)) return false;
      const named = namedInstruments(t);
      if (!named.length) return true;                  // market-wide notice
      return named.includes(base) || mentions(t);      // otherwise it must be about THIS instrument
    });
    const score = (r: any) => isExchange(r) && mentions(r.title) ? 3 : (r.primary_source ? 2 : 1);
    rows.sort((a, b) => score(b) - score(a) || b.published_at - a.published_at);
    rows = rows.slice(0, limit);
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
