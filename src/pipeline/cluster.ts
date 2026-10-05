import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { DomainResolver } from "../domains.ts";
import { BudgetExhausted, centroid, cosine, type Llm } from "../llm.ts";
import { errMsg, log } from "../log.ts";
import { TIER_WEIGHT } from "../sources.ts";
import { hoursAgo, nowIso, rootDomain } from "../util.ts";
import { scoreEvent } from "./score.ts";
import type { Triage } from "./triage.ts";

// Thresholds for gemini-embedding-001 (768d, CLUSTERING task). Unrelated
// security news sits around 0.75–0.85, the same story across languages ≥ 0.9.
export const SIM_STRONG = 0.935;
export const SIM_MERGE = 0.885;
export const SIM_KEY = 0.83;

export function keyTokens(key: string): Set<string> {
  return new Set(
    key.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !/^20\d\d$/.test(t) && !/^(the|and|for|with)$/.test(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Candidate {
  id: number;
  embedding: number[] | null;
  key: Set<string>;
  category: string | null;
  region: string | null;
}

/** Explainable merge decision. Conservative: two events beat one wrong merge. */
export function decideMerge(
  vec: number[] | null,
  t: Pick<Triage, "event_key" | "category" | "region">,
  events: Candidate[],
): { id: number; reason: string } | null {
  const key = keyTokens(t.event_key);
  let best: { id: number; reason: string; score: number } | null = null;
  for (const e of events) {
    const kj = jaccard(key, e.key);
    const sameRegion = !!t.region && !!e.region && t.region.toLowerCase() === e.region.toLowerCase();
    const sameCat = t.category === e.category;
    let reason = "";
    if (!vec || !e.embedding) {
      // Degraded mode (embedding quota exhausted): lexical event_key evidence only, stricter.
      if (kj >= 0.6 || (kj >= 0.45 && sameRegion && sameCat)) reason = `event_key ${kj.toFixed(2)} (no embedding)`;
      if (reason && (!best || kj > best.score)) best = { id: e.id, reason, score: kj };
      continue;
    }
    const cos = cosine(vec, e.embedding);
    if (cos >= SIM_STRONG) reason = `cos ${cos.toFixed(3)} ≥ strong`;
    else if (cos >= SIM_MERGE && (kj >= 0.4 || (sameRegion && sameCat))) reason = `cos ${cos.toFixed(3)} + key ${kj.toFixed(2)} / region+category`;
    else if (cos >= SIM_KEY && kj >= 0.6) reason = `event_key ${kj.toFixed(2)} + cos ${cos.toFixed(3)}`;
    if (reason) {
      const score = cos + kj * 0.1;
      if (!best || score > best.score) best = { id: e.id, reason, score };
    }
  }
  return best ? { id: best.id, reason: best.reason } : null;
}

const normOrigin = (s: string) => s.toLowerCase().replace(/^the /, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

interface MemberRow {
  id: number;
  url: string;
  domain: string;
  triage: string;
  published_at: string | null;
  collected_at: string;
  embedding: string | null;
  relevance: number;
  tier: string;
  side: string;
  source_id: number;
  kind: string;
}

/** Recompute an event's aggregates from its member articles. */
export function refreshEvent(db: Db, eventId: number, resolver: DomainResolver) {
  const members = db.all<MemberRow>(
    `SELECT a.id, a.url, a.domain, a.triage, a.published_at, a.collected_at, a.embedding, a.relevance, s.tier, s.side, s.kind, s.id AS source_id
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.event_id = ? ORDER BY a.collected_at`,
    eventId,
  );
  if (!members.length) return;
  const origins = new Set<string>();
  const sides = new Set<string>();
  let bestTier = "G";
  const votes = { category: new Map<string, number>(), signal: new Map<string, number>(), region: new Map<string, number>() };
  let eventDate: string | null = null;
  let titleFrom: { w: number; text: string } | null = null;
  for (const m of members) {
    const t = json<Partial<Triage>>(m.triage, {});
    // GDELT items are attributed to their real publisher domain, not to the GDELT "source".
    const info = resolver.resolve(m.domain);
    const viaDomain = m.kind === "gdelt" || m.kind === "linked";
    const tier = viaDomain ? info.tier : m.tier;
    const side = viaDomain ? info.side : m.side;
    sides.add(side);
    if ((TIER_WEIGHT[tier] ?? 0) > (TIER_WEIGHT[bestTier] ?? 0)) bestTier = tier;
    // Independence: a re-print of Reuters is Reuters, not a new confirmation.
    origins.add(t.original_source ? normOrigin(t.original_source) : rootDomain(m.domain));
    const w = (TIER_WEIGHT[tier] ?? 0.3) * (m.relevance ?? 0.5);
    for (const [k, v] of [["category", t.category], ["signal", t.signal], ["region", t.region]] as const)
      if (v) votes[k].set(v, (votes[k].get(v) ?? 0) + w);
    if (t.event_date && (!eventDate || t.event_date < eventDate)) eventDate = t.event_date;
    if (!titleFrom || w > titleFrom.w) titleFrom = { w, text: t.summary || "" };
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const vecs = members.map((m) => json<number[] | null>(m.embedding, null)).filter((v): v is number[] => !!v).slice(-30);
  db.run(
    `UPDATE events SET updated_at = ?, article_count = ?, independent_count = ?, origins = ?, best_tier = ?, sides = ?,
     category = ?, signal = ?, region = ?, event_date = COALESCE(?, event_date), embedding = ?, title = COALESCE(NULLIF(?, ''), title)
     WHERE id = ?`,
    nowIso(), members.length, origins.size, JSON.stringify([...origins]), bestTier, JSON.stringify([...sides]),
    top(votes.category), top(votes.signal), top(votes.region), eventDate, vecs.length ? JSON.stringify(centroid(vecs)) : null, titleFrom?.text ?? "", eventId,
  );
}

export async function clusterRelevant(db: Db, llm: Llm, cfg: Config): Promise<{ embedded: number; attached: number; created: number; error?: string }> {
  const rows = db.all<{ id: number; title: string; triage: string; domain: string }>(
    "SELECT id, title, triage, domain FROM articles WHERE status = 'relevant' AND event_id IS NULL ORDER BY collected_at LIMIT 300",
  );
  if (!rows.length) return { embedded: 0, attached: 0, created: 0 };
  let vectors: (number[] | null)[];
  let error: string | undefined;
  try {
    vectors = await llm.embed(rows.map((r) => `${r.title}\n${json<Partial<Triage>>(r.triage, {}).summary ?? ""}`));
  } catch (e) {
    // Keep the pipeline moving: cluster on lexical evidence instead of stalling analysis for a day.
    error = errMsg(e) + (e instanceof BudgetExhausted ? " (budget)" : "");
    log.warn("embedding failed — lexical clustering fallback", { err: error });
    vectors = rows.map(() => null);
  }
  const resolver = new DomainResolver(db);
  const events: Candidate[] = db
    .all<{ id: number; embedding: string; event_key: string; category: string; region: string }>(
      "SELECT id, embedding, event_key, category, region FROM events WHERE updated_at >= ? AND status != 'merged'",
      hoursAgo(cfg.EVENT_WINDOW_HOURS),
    )
    .map((e) => ({ id: e.id, embedding: json<number[] | null>(e.embedding, null), key: keyTokens(e.event_key), category: e.category, region: e.region }));

  let attached = 0;
  let created = 0;
  const touched = new Set<number>();
  db.tx(() => {
    rows.forEach((r, i) => {
      const t = json<Triage>(r.triage, {} as Triage);
      const vec = vectors[i];
      db.run("UPDATE articles SET embedding = ? WHERE id = ?", vec ? JSON.stringify(vec) : null, r.id);
      const match = decideMerge(vec, t, events);
      let eventId: number;
      if (match) {
        eventId = match.id;
        attached++;
        log.debug("merge", { article: r.id, event: eventId, reason: match.reason });
      } else {
        const now = nowIso();
        eventId = Number(
          db.run(
            "INSERT INTO events(created_at, updated_at, title, event_key, category, signal, region, event_date, embedding) VALUES(?,?,?,?,?,?,?,?,?)",
            now, now, t.summary || r.title, t.event_key ?? "", t.category ?? null, t.signal ?? null, t.region ?? null, t.event_date ?? null, vec ? JSON.stringify(vec) : null,
          ).lastInsertRowid,
        );
        events.push({ id: eventId, embedding: vec, key: keyTokens(t.event_key ?? ""), category: t.category, region: t.region });
        created++;
      }
      db.run("UPDATE articles SET event_id = ?, status = 'clustered' WHERE id = ?", eventId, r.id);
      touched.add(eventId);
    });
    for (const id of touched) {
      const before = db.get<{ independent_count: number; best_tier: string | null }>("SELECT independent_count, best_tier FROM events WHERE id = ?", id)!;
      refreshEvent(db, id, resolver);
      const after = db.get<{ independent_count: number; best_tier: string; embedding: string | null }>("SELECT independent_count, best_tier, embedding FROM events WHERE id = ?", id)!;
      // Re-analyse only when the sourcing picture changed — new independent origin or a stronger tier.
      if (after.independent_count > before.independent_count || after.best_tier !== before.best_tier || !before.best_tier) {
        db.run("UPDATE events SET needs_analysis = 1 WHERE id = ?", id);
        // Sourcing changed: refresh importance now from the existing analysis instead of waiting
        // for the analysis queue (corroboration is part of the score).
        scoreEvent(db, id);
      }
      const cand = events.find((e) => e.id === id);
      if (cand) cand.embedding = json<number[] | null>(after.embedding, cand.embedding);
    }
  });
  const embedded = vectors.filter(Boolean).length;
  log.info("cluster done", { embedded, attached, created });
  return { embedded, attached, created, ...(error ? { error } : {}) };
}
