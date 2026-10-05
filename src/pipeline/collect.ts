import { collectors } from "../collectors/index.ts";
import type { RawItem, SourceRow } from "../collectors/types.ts";
import { collectWeb } from "../collectors/web.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { activeSources } from "../sources.ts";
import { canonicalUrl, domainOf, hoursAgo, normalizeTitle, nowIso, sha } from "../util.ts";
import { PREFILTER_VERSION, prefilterScore } from "./prefilter.ts";

export interface CollectStats {
  sources: number;
  failed: number;
  fetched: number;
  inserted: number;
  old: number;
  duplicates: number;
  filtered: number;
  errors: Record<string, string>;
}

async function fetchSource(db: Db, s: SourceRow): Promise<RawItem[]> {
  if (s.kind === "web") {
    const known = db.raw.prepare("SELECT 1 FROM articles WHERE url = ?");
    return collectWeb(s, (u) => {
      try {
        return !!known.get(canonicalUrl(u));
      } catch {
        return true;
      }
    });
  }
  return collectors[s.kind as Exclude<SourceRow["kind"], "web">].collect(s);
}

/** When the screen's vocabulary changes, give recently filtered items one more look. */
export function rescreenFiltered(db: Db, cfg: Config): number {
  if (db.kvGet("prefilter_version") === String(PREFILTER_VERSION)) return 0;
  const rows = db.all<{ id: number; title: string; body: string; focused: number; tier: string }>(
    `SELECT a.id, a.title, a.body, s.focused, s.tier FROM articles a JOIN sources s ON s.id = a.source_id
     WHERE a.status = 'filtered' AND a.collected_at >= ?`,
    hoursAgo(cfg.MAX_ARTICLE_AGE_HOURS),
  );
  let revived = 0;
  db.tx(() => {
    for (const r of rows) {
      const pf = prefilterScore(`${r.title}\n${r.body}`);
      const pass = r.focused ? pf >= 1 || r.tier === "A" || r.tier === "E" : pf >= 2;
      if (pass) {
        db.run("UPDATE articles SET status = 'new', prefilter = ? WHERE id = ?", pf, r.id);
        revived++;
      }
    }
    db.kvSet("prefilter_version", String(PREFILTER_VERSION));
  });
  if (revived) log.info("re-screened filtered items", { revived, of: rows.length });
  return revived;
}

export async function collectAll(db: Db, cfg: Config, only?: string[]): Promise<CollectStats> {
  rescreenFiltered(db, cfg);
  let sources = activeSources(db).filter((s) => cfg.GDELT_ENABLED || s.kind !== "gdelt");
  if (only?.length) sources = sources.filter((s) => only.includes(s.key));
  const stats: CollectStats = { sources: sources.length, failed: 0, fetched: 0, inserted: 0, old: 0, duplicates: 0, filtered: 0, errors: {} };

  // GDELT enforces 1 req / 5 s per IP, so those run sequentially in their own lane.
  // GDELT throttles per IP: one query per cycle, rotating (least recently fetched first).
  const gdelt = sources
    .filter((s) => s.kind === "gdelt")
    .sort((a, b) => (a.last_fetch_at ?? "").localeCompare(b.last_fetch_at ?? ""))
    .slice(0, only?.length ? 4 : 1);
  stats.sources = sources.filter((s) => s.kind !== "gdelt").length + gdelt.length;
  const rest = sources.filter((s) => s.kind !== "gdelt");
  const results: [SourceRow, RawItem[] | Error][] = [];

  const lane = async (list: SourceRow[], width: number) => {
    const queue = [...list];
    await Promise.all(
      Array.from({ length: width }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try {
            results.push([s, await fetchSource(db, s)]);
          } catch (e) {
            results.push([s, e instanceof Error ? e : new Error(String(e))]);
          }
        }
      }),
    );
  };
  await Promise.all([lane(rest, 8), lane(gdelt, 1)]);

  const cutoff = hoursAgo(cfg.MAX_ARTICLE_AGE_HOURS);
  const future = new Date(Date.now() + 15 * 60_000).toISOString();
  const now = nowIso();

  for (const [s, res] of results) {
    db.run("UPDATE sources SET last_fetch_at = ? WHERE id = ?", now, s.id);
    if (res instanceof Error) {
      stats.failed++;
      stats.errors[s.key] = errMsg(res);
      db.run(
        "UPDATE sources SET consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?",
        errMsg(res), s.id,
      );
      continue;
    }
    stats.fetched += res.length;
    let inserted = 0;
    let newest: string | null = null;
    db.tx(() => {
      for (const item of res) {
        let url: string;
        try {
          url = canonicalUrl(item.url);
        } catch {
          continue;
        }
        if (db.get("SELECT 1 FROM articles WHERE url = ?", url)) continue;
        const title = item.title.trim();
        if (title.length < 8) continue;
        const titleKey = sha(normalizeTitle(title));
        const published = item.publishedAt && item.publishedAt <= future ? item.publishedAt : null;
        if (published && (!newest || published > newest)) newest = published;
        // Status decided up-front by cheap deterministic checks; the rest waits for triage.
        let status = "new";
        if (published && published < cutoff) status = "old";
        else if (db.get("SELECT 1 FROM articles WHERE title_key = ? AND collected_at > ?", titleKey, hoursAgo(72)))
          status = "duplicate";
        const pf = prefilterScore(`${title}\n${item.body}`);
        if (status === "new" && !s.focused && pf < 2) status = "filtered";
        if (status === "new" && s.focused && pf < 1 && s.tier !== "A" && s.tier !== "E") status = "filtered";
        db.run(
          `INSERT INTO articles(url, title, title_key, body, domain, source_id, lang, published_at, collected_at, links, prefilter, status)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          url, title, titleKey, item.body ?? "", item.domain ?? domainOf(url), s.id, item.lang ?? s.lang ?? null,
          published, now, JSON.stringify(item.links ?? []), pf, status,
        );
        inserted++;
        if (status === "old") stats.old++;
        else if (status === "duplicate") stats.duplicates++;
        else if (status === "filtered") stats.filtered++;
      }
    });
    stats.inserted += inserted;
    db.run(
      `UPDATE sources SET consecutive_failures = 0, last_error = NULL, last_success_at = ?, total_items = total_items + ?,
       last_item_at = COALESCE(?, last_item_at), status = CASE WHEN status = 'dead' THEN 'active' ELSE status END WHERE id = ?`,
      now, inserted, newest, s.id,
    );
  }
  log.info("collect done", { ...stats, errors: Object.keys(stats.errors).length });
  return stats;
}
