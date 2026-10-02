import { extractArticleMeta } from "../collectors/web.ts";
import { type Db, json } from "../db.ts";
import type { DomainResolver } from "../domains.ts";
import { fetchText } from "../http.ts";
import { log } from "../log.ts";
import { canonicalUrl, domainOf, normalizeTitle, nowIso, sha } from "../util.ts";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 RussiaNatoMonitor/0.1";

/** Owner row for documents fetched by following links; never collected directly. */
function linkedSourceId(db: Db): number {
  db.run(
    `INSERT OR IGNORE INTO sources(key, name, kind, url, tier, side, reliability, focused, enabled, status, origin, created_at)
     VALUES('linked-primary', 'Первоисточник по ссылке', 'linked', 'https://linked.invalid/', 'A', 'neutral', 0.85, 1, 0, 'disabled', 'seed', ?)`,
    nowIso(),
  );
  return db.get<{ id: number }>("SELECT id FROM sources WHERE key = 'linked-primary'")!.id;
}

/**
 * Follow links from an event's articles to official / wire originals (tier A–B)
 * and attach those documents to the event, so the editor can cite the primary
 * source instead of a re-print. Bounded: ≤ `max` new fetches per event, ever.
 */
export async function attachPrimarySources(db: Db, eventId: number, resolver: DomainResolver, max = 2): Promise<number> {
  const members = db.all<{ url: string; links: string; domain: string }>("SELECT url, links, domain FROM articles WHERE event_id = ?", eventId);
  const have = new Set(members.map((m) => m.url));
  const memberDomains = new Set(members.map((m) => m.domain));
  const candidates: string[] = [];
  for (const m of members) {
    for (const link of json<string[]>(m.links, [])) {
      let url: string;
      try {
        url = canonicalUrl(link);
      } catch {
        continue;
      }
      const host = domainOf(url);
      const info = resolver.resolve(host);
      if (!["A", "B"].includes(info.tier) || memberDomains.has(host) || have.has(url)) continue;
      if (new URL(url).pathname.length < 8) continue; // homepages are not documents
      if (!candidates.includes(url)) candidates.push(url);
    }
  }
  let attached = 0;
  const owner = linkedSourceId(db);
  for (const url of candidates) {
    if (attached >= max) break;
    const flag = `primary:${sha(url)}`;
    if (db.kvGet(flag)) continue;
    db.kvSet(flag, nowIso());
    if (db.get("SELECT 1 FROM articles WHERE url = ?", url)) continue;
    try {
      const page = await fetchText(url, { headers: { "User-Agent": BROWSER_UA }, timeoutMs: 20_000 });
      const meta = extractArticleMeta(page.text, url);
      if (!meta.title || meta.body.length < 120) continue;
      const info = resolver.resolve(domainOf(url));
      db.run(
        `INSERT INTO articles(url, title, title_key, body, domain, source_id, published_at, collected_at, links, prefilter, status, triage, relevance, event_id)
         VALUES(?,?,?,?,?,?,?,?,?,0,'clustered',?,0.8,?)`,
        url, meta.title, sha(normalizeTitle(meta.title)), meta.body, domainOf(url), owner, meta.publishedAt, nowIso(), "[]",
        JSON.stringify({ statement_type: info.tier === "A" ? "OFFICIAL_CLAIM" : "FACT", original_source: null, summary: meta.title }),
        eventId,
      );
      attached++;
      log.info("primary source attached", { event: eventId, url, tier: info.tier });
    } catch {
      /* unreachable original: the re-print stays the best we have */
    }
  }
  return attached;
}
