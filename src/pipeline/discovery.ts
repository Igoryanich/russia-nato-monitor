import { discoverFeed, parseFeed } from "../collectors/rss.ts";
import { parseTelegramPreview } from "../collectors/telegram.ts";
import { type Db, json } from "../db.ts";
import { DomainResolver } from "../domains.ts";
import { fetchText } from "../http.ts";
import { errMsg, log } from "../log.ts";
import { domainOf, hoursAgo, nowIso, rootDomain } from "../util.ts";
import { prefilterScore } from "./prefilter.ts";
import type { Triage } from "./triage.ts";

// Hosts that are platforms, not sources; individual Telegram channels are handled separately.
const IGNORE =
  /(^|\.)(facebook\.com|instagram\.com|youtube\.com|youtu\.be|google\.[a-z.]+|apple\.com|linkedin\.com|tiktok\.com|wikipedia\.org|archive\.org|doi\.org|bit\.ly|goo\.gl|amzn\.|amazon\.|spotify\.com|soundcloud\.com|patreon\.com|paypal\.com|substackcdn\.com|cloudfront\.net|wp\.com|gravatar\.com|w3\.org|schema\.org|creativecommons\.org|feedburner\.com|mailchimp|eepurl\.com|whatsapp\.com|vk\.com|vk\.ru|vkvideo\.ru|rutube\.ru|max\.ru|dzen\.ru|ok\.ru|x\.com|twitter\.com|bsky\.app|reddit\.com|threads\.net|t\.co)$/i;

function bump(db: Db, domain: string, opts: { name?: string; url?: string; original?: boolean; eventId?: number | null }) {
  const now = nowIso();
  const row = db.get<{ id: number; names: string; sample_urls: string; event_ids: string; status: string }>(
    "SELECT id, names, sample_urls, event_ids, status FROM source_candidates WHERE domain = ?", domain,
  );
  if (!row) {
    db.run(
      "INSERT INTO source_candidates(domain, names, sample_urls, mentions, original_mentions, event_ids, first_seen, last_seen) VALUES(?,?,?,?,?,?,?,?)",
      domain, JSON.stringify(opts.name ? [opts.name] : []), JSON.stringify(opts.url ? [opts.url] : []), 1, opts.original ? 1 : 0,
      JSON.stringify(opts.eventId ? [opts.eventId] : []), now, now,
    );
    return;
  }
  if (row.status === "rejected" || row.status === "promoted") return;
  const names = new Set(json<string[]>(row.names, []));
  if (opts.name) names.add(opts.name);
  const urls = new Set(json<string[]>(row.sample_urls, []));
  if (opts.url && urls.size < 5) urls.add(opts.url);
  const events = new Set(json<number[]>(row.event_ids, []));
  if (opts.eventId) events.add(opts.eventId);
  db.run(
    "UPDATE source_candidates SET names = ?, sample_urls = ?, event_ids = ?, mentions = mentions + 1, original_mentions = original_mentions + ?, last_seen = ? WHERE id = ?",
    JSON.stringify([...names].slice(0, 8)), JSON.stringify([...urls]), JSON.stringify([...events].slice(-30)), opts.original ? 1 : 0, now, row.id,
  );
}

/**
 * Harvest candidate sources from relevant articles collected since the last pass:
 * outbound links (who do good articles cite?) and Telegram channels linked from them.
 */
export function harvestCandidates(db: Db): number {
  const since = db.kvGet("discovery_cursor") ?? "0";
  const rows = db.all<{ id: number; links: string; triage: string; event_id: number | null; domain: string }>(
    "SELECT id, links, triage, event_id, domain FROM articles WHERE status = 'clustered' AND id > ? ORDER BY id",
    Number(since),
  );
  if (!rows.length) return 0;
  const resolver = new DomainResolver(db);
  const known = new Set(db.all<{ url: string }>("SELECT url FROM sources").map((s) => domainOf(s.url)));
  let n = 0;
  db.tx(() => {
    for (const r of rows) {
      const t = json<Partial<Triage>>(r.triage, {});
      for (const link of json<string[]>(r.links, [])) {
        const host = domainOf(link);
        if (!host || host === r.domain || IGNORE.test(host)) continue;
        if (host === "t.me") {
          const ch = link.split("/")[3];
          if (ch && /^[A-Za-z0-9_]{5,}$/.test(ch) && ch !== "s" && !known.has(`t.me/${ch}`)) {
            bump(db, `t.me/${ch}`, { url: `https://t.me/s/${ch}`, eventId: r.event_id });
            n++;
          }
          continue;
        }
        const root = rootDomain(host);
        if (resolver.resolve(host).known || known.has(host) || known.has(root)) continue;
        bump(db, host, { url: link, eventId: r.event_id, original: !!t.original_source && host.includes((t.original_source ?? "").toLowerCase().split(" ")[0]) });
        n++;
      }
    }
    db.kvSet("discovery_cursor", String(rows.at(-1)!.id));
  });
  return n;
}

/** Probe a few promising candidates for a feed; good ones enter the registry in `testing`. */
export async function probeCandidates(db: Db, max = 3): Promise<{ probed: number; promoted: number }> {
  const rows = db.all<{ id: number; domain: string; mentions: number; original_mentions: number; sample_urls: string; event_ids: string }>(
    `SELECT id, domain, mentions, original_mentions, sample_urls, event_ids FROM source_candidates
     WHERE status IN ('new','no_feed') AND (probed_at IS NULL OR probed_at < ?)
       AND (mentions >= 3 OR original_mentions >= 1) ORDER BY original_mentions DESC, mentions DESC LIMIT ?`,
    hoursAgo(24 * 7), max,
  );
  let promoted = 0;
  for (const c of rows) {
    db.run("UPDATE source_candidates SET probed_at = ? WHERE id = ?", nowIso(), c.id);
    // Corroboration history: mentioned across several distinct events, not one viral link.
    const distinctEvents = json<number[]>(c.event_ids, []).length;
    try {
      if (c.domain.startsWith("t.me/")) {
        const ch = c.domain.slice(5);
        const items = parseTelegramPreview((await fetchText(`https://t.me/s/${ch}`)).text, ch);
        const topical = items.filter((i) => prefilterScore(i.body) >= 2).length;
        if (items.length >= 5 && topical / items.length >= 0.3 && distinctEvents >= 2) {
          promote(db, c.domain, { kind: "telegram", url: `https://t.me/s/${ch}`, name: `t.me/${ch}`, tier: "G", note: `topical ${topical}/${items.length}` });
          promoted++;
        } else db.run("UPDATE source_candidates SET status = 'no_feed', note = ? WHERE id = ?", `topical ${topical}/${items.length}, events ${distinctEvents}`, c.id);
        continue;
      }
      const feed = await discoverFeed(`https://${c.domain}/`);
      if (!feed) {
        db.run("UPDATE source_candidates SET status = 'no_feed', note = 'no RSS found' WHERE id = ?", c.id);
        continue;
      }
      const items = await parseFeed((await fetchText(feed)).text, 40);
      const topical = items.filter((i) => prefilterScore(`${i.title}\n${i.body}`) >= 2).length;
      db.run("UPDATE source_candidates SET feed_url = ?, note = ? WHERE id = ?", feed, `topical ${topical}/${items.length}, events ${distinctEvents}`, c.id);
      if (items.length && (topical >= 3 || c.original_mentions >= 2) && distinctEvents >= 2) {
        const info = new DomainResolver(db).resolve(c.domain);
        promote(db, c.domain, { kind: "rss", url: feed, name: c.domain, tier: info.tier, side: info.side, focused: topical / items.length >= 0.5 });
        promoted++;
      } else db.run("UPDATE source_candidates SET status = 'no_feed' WHERE id = ?", c.id);
    } catch (e) {
      db.run("UPDATE source_candidates SET note = ? WHERE id = ?", `probe failed: ${errMsg(e)}`, c.id);
    }
  }
  if (rows.length) log.info("discovery probe", { probed: rows.length, promoted });
  return { probed: rows.length, promoted };
}

function promote(
  db: Db,
  domain: string,
  s: { kind: string; url: string; name: string; tier: string; side?: string; focused?: boolean; note?: string },
  origin = "discovered",
) {
  const key = `disc-${domain.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60);
  db.run(
    `INSERT OR IGNORE INTO sources(key, name, kind, url, tier, side, country, lang, reliability, focused, config, enabled, status, origin, created_at)
     VALUES(?,?,?,?,?,?,'','',?,?,'{}',1,'testing',?,?)`,
    key, s.name, s.kind, s.url, s.tier, s.side ?? "neutral", s.tier === "A" ? 0.8 : 0.5, s.focused ? 1 : 0, origin, nowIso(),
  );
  db.run("UPDATE source_candidates SET status = 'promoted', note = COALESCE(?, note) WHERE domain = ?", s.note ?? null, domain);
  log.info("source promoted to testing", { domain, url: s.url, tier: s.tier });
}

export function promoteCandidate(db: Db, domain: string, origin: string): string {
  const c = db.get<{ feed_url: string | null }>("SELECT feed_url FROM source_candidates WHERE domain = ?", domain);
  if (!c) return `Кандидат ${domain} не найден`;
  if (domain.startsWith("t.me/")) {
    promote(db, domain, { kind: "telegram", url: `https://t.me/s/${domain.slice(5)}`, name: domain, tier: "G" }, origin);
    return `Канал ${domain} добавлен на испытание`;
  }
  if (!c.feed_url) return `У ${domain} не найден RSS — добавьте источник в config/sources.yaml вручную`;
  const info = new DomainResolver(db).resolve(domain);
  promote(db, domain, { kind: "rss", url: c.feed_url, name: domain, tier: info.tier, side: info.side }, origin);
  return `Источник ${domain} добавлен на испытание`;
}

export function blockCandidate(db: Db, domain: string): string {
  const r = db.run("UPDATE source_candidates SET status = 'rejected' WHERE domain = ?", domain);
  db.run("UPDATE sources SET enabled = 0, status = 'disabled' WHERE origin = 'discovered' AND url LIKE ?", `%${domain}%`);
  return r.changes ? `${domain} заблокирован` : `Кандидат ${domain} не найден`;
}

/** Testing sources graduate after proving useful, or are dropped after two quiet weeks. */
export function reviewTestingSources(db: Db): { graduated: number; dropped: number } {
  const g = db.run("UPDATE sources SET status = 'active' WHERE status = 'testing' AND relevant_items >= 5 AND consecutive_failures = 0");
  const d = db.run(
    "UPDATE sources SET status = 'disabled', enabled = 0 WHERE status = 'testing' AND created_at < ? AND relevant_items < 2",
    hoursAgo(24 * 14),
  );
  return { graduated: Number(g.changes), dropped: Number(d.changes) };
}
