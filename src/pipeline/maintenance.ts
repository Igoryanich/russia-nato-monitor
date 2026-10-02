import { discoverFeed } from "../collectors/rss.ts";
import { type Db, json } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { hoursAgo, nowIso } from "../util.ts";

/**
 * Source health: a source failing 5 cycles in a row is marked dead and, once a
 * day, we try to find its new feed URL from the site's homepage.
 */
export async function sourceHealth(db: Db): Promise<{ dead: number; recovered: number }> {
  const marked = db.run(
    "UPDATE sources SET status = 'dead' WHERE enabled = 1 AND status IN ('active','testing','recovered') AND consecutive_failures >= 5",
  );
  let recovered = 0;
  const dead = db.all<{ id: number; key: string; url: string; kind: string }>(
    "SELECT id, key, url, kind FROM sources WHERE status = 'dead' AND enabled = 1 AND kind = 'rss' LIMIT 3",
  );
  for (const s of dead) {
    const k = `recover:${s.id}`;
    if ((db.kvGet(k) ?? "") > hoursAgo(24)) continue;
    db.kvSet(k, nowIso());
    try {
      const feed = await discoverFeed(new URL(s.url).origin + "/");
      if (feed && feed !== s.url) {
        db.run("UPDATE sources SET url = ?, status = 'recovered', consecutive_failures = 0, last_error = ? WHERE id = ?", feed, `URL recovered from ${s.url}`, s.id);
        recovered++;
        log.info("source URL recovered", { key: s.key, from: s.url, to: feed });
      }
    } catch (e) {
      log.debug("recovery failed", { key: s.key, err: errMsg(e) });
    }
  }
  return { dead: Number(marked.changes), recovered };
}

/**
 * Feedback loop: once an event is corroborated by ≥ 2 independent origins with at
 * least one A/B/C-tier source, credit who reported first and who reported
 * originally. Reliability drifts toward the observed record, slowly.
 */
export function creditSources(db: Db): number {
  const events = db.all<{ id: number }>(
    `SELECT id FROM events WHERE independent_count >= 2 AND best_tier IN ('A','B','C')
     AND id NOT IN (SELECT CAST(substr(key, 8) AS INTEGER) FROM kv WHERE key LIKE 'credit:%')
     AND updated_at >= ?`,
    hoursAgo(24 * 7),
  );
  for (const ev of events) {
    const arts = db.all<{ source_id: number; published_at: string | null; collected_at: string; triage: string }>(
      "SELECT source_id, published_at, collected_at, triage FROM articles WHERE event_id = ? ORDER BY COALESCE(published_at, collected_at)",
      ev.id,
    );
    if (!arts.length) continue;
    db.tx(() => {
      db.run("UPDATE sources SET first_reports = first_reports + 1 WHERE id = ?", arts[0].source_id);
      const seen = new Set<number>();
      for (const a of arts) {
        if (seen.has(a.source_id)) continue;
        seen.add(a.source_id);
        const original = !json<{ original_source?: string | null }>(a.triage, {}).original_source;
        db.run(
          "UPDATE sources SET confirmed_reports = confirmed_reports + 1, original_reports = original_reports + ? WHERE id = ?",
          original ? 1 : 0, a.source_id,
        );
      }
      db.kvSet(`credit:${ev.id}`, nowIso());
    });
  }
  // Beta-style update: prior worth 20 observations; false reports cost double. Social tier capped.
  db.run(
    `UPDATE sources SET reliability = MIN(CASE tier WHEN 'G' THEN 0.7 WHEN 'S' THEN 0.65 ELSE 0.97 END,
       (reliability * 20 + confirmed_reports * 0.95) / (20 + confirmed_reports + 2 * false_reports))
     WHERE confirmed_reports + false_reports > 0 AND id IN (SELECT DISTINCT source_id FROM articles WHERE event_id IN (${events.map((e) => e.id).join(",") || "NULL"}))`,
  );
  return events.length;
}

/** Keep the SQLite file small enough to live in git: drop text we no longer need. */
export function prune(db: Db) {
  db.run("UPDATE articles SET body = '', links = '[]', embedding = NULL WHERE status IN ('filtered','irrelevant','old','duplicate') AND collected_at < ? AND body != ''", hoursAgo(48));
  db.run("DELETE FROM articles WHERE status IN ('filtered','irrelevant','old','duplicate') AND collected_at < ?", hoursAgo(24 * 10));
  db.run("UPDATE articles SET body = substr(body, 1, 600), embedding = NULL WHERE event_id IS NOT NULL AND collected_at < ?", hoursAgo(24 * 21));
  db.run("UPDATE events SET embedding = NULL WHERE updated_at < ? AND embedding IS NOT NULL", hoursAgo(24 * 14));
  db.run("DELETE FROM kv WHERE key LIKE 'credit:%' AND value < ?", hoursAgo(24 * 30));
  db.run("DELETE FROM runs WHERE started_at < ?", hoursAgo(24 * 60));
  // Reclaim space once a day so the committed file stays small.
  const day = nowIso().slice(0, 10);
  if (db.kvGet("vacuum_day") !== day) {
    db.kvSet("vacuum_day", day);
    db.raw.exec("VACUUM");
  }
}
