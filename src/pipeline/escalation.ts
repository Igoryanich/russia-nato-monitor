import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { localDate, nowIso } from "../util.ts";
import type { Analysis } from "./analyze.ts";

export interface IndexDriver {
  event_id: number;
  headline: string;
  contribution: number;
}

export interface IndexValue {
  day: string;
  value: number;
  drivers: IndexDriver[];
  counters: IndexDriver[];
}

// Escalation Signal Index 0–100: aggregated intensity of OBSERVED indicators over
// the last 7 days with a 3-day half-life-ish decay. It is not a probability of war.
const WINDOW_DAYS = 7;
const DECAY_DAYS = 3;
const SATURATION = 4; // raw signal at which the index reaches ~63
const COUNTER_FACTOR = 0.6; // counter-signals offset, but do not erase, escalation signals

export function computeIndex(db: Db, at = new Date()): Omit<IndexValue, "day"> {
  const since = new Date(at.getTime() - WINDOW_DAYS * 86400_000).toISOString();
  const rows = db.all<{ id: number; escalation_weight: number; created_at: string; event_date: string | null; analysis: string }>(
    `SELECT id, escalation_weight, created_at, event_date, analysis FROM events
     WHERE escalation_weight IS NOT NULL AND escalation_weight != 0 AND created_at >= ? AND created_at <= ?
       AND status NOT IN ('rejected','merged') AND novelty NOT IN ('DUPLICATE','OLD_RESURFACED')`,
    since, at.toISOString(),
  );
  let esc = 0;
  let cnt = 0;
  const drivers: IndexDriver[] = [];
  const counters: IndexDriver[] = [];
  for (const r of rows) {
    const when = r.event_date && r.event_date < r.created_at ? `${r.event_date}T12:00:00Z` : r.created_at;
    const ageDays = Math.max(0, (at.getTime() - Date.parse(when)) / 86400_000);
    const c = r.escalation_weight * Math.exp(-ageDays / DECAY_DAYS);
    const headline = json<Analysis | null>(r.analysis, null)?.headline_ru ?? `событие #${r.id}`;
    if (c > 0) {
      esc += c;
      drivers.push({ event_id: r.id, headline, contribution: Math.round(c * 100) / 100 });
    } else {
      cnt += -c;
      counters.push({ event_id: r.id, headline, contribution: Math.round(-c * 100) / 100 });
    }
  }
  const raw = Math.max(0, esc - COUNTER_FACTOR * cnt);
  const value = Math.round(100 * (1 - Math.exp(-raw / SATURATION)));
  const byC = (a: IndexDriver, b: IndexDriver) => b.contribution - a.contribution;
  return { value, drivers: drivers.sort(byC).slice(0, 6), counters: counters.sort(byC).slice(0, 4) };
}

export function updateIndex(db: Db, cfg: Config): IndexValue {
  const day = localDate(cfg.TIMEZONE);
  const v = computeIndex(db);
  db.run(
    `INSERT INTO index_history(day, value, drivers, counters, computed_at) VALUES(?,?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET value = excluded.value, drivers = excluded.drivers, counters = excluded.counters, computed_at = excluded.computed_at`,
    day, v.value, JSON.stringify(v.drivers), JSON.stringify(v.counters), nowIso(),
  );
  return { day, ...v };
}

export function indexOn(db: Db, day: string): number | null {
  return db.get<{ value: number }>("SELECT value FROM index_history WHERE day <= ? ORDER BY day DESC LIMIT 1", day)?.value ?? null;
}
