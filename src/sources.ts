import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { SourceRow } from "./collectors/types.ts";
import type { Db } from "./db.ts";
import { nowIso } from "./util.ts";

export const TIERS = ["A", "B", "C", "D", "E", "F", "G", "S"] as const;
export type Tier = (typeof TIERS)[number];

/** Weight of a tier when judging how solid an event's sourcing is. */
export const TIER_WEIGHT: Record<string, number> = { A: 1, B: 0.95, C: 0.8, D: 0.7, E: 0.6, F: 0.55, S: 0.4, G: 0.25 };

const seedSchema = z.object({
  defaults: z.record(z.string(), z.object({ reliability: z.number(), focused: z.boolean() })),
  sources: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      kind: z.enum(["rss", "telegram", "web", "gdelt", "bluesky"]),
      url: z.string(),
      tier: z.enum(TIERS),
      side: z.enum(["nato", "ru", "by", "ua", "neutral"]),
      country: z.string().default(""),
      lang: z.string().default(""),
      reliability: z.number().min(0).max(1).optional(),
      focused: z.boolean().optional(),
      enabled: z.boolean().default(true),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});

export type SeedSource = z.infer<typeof seedSchema>["sources"][number];

export function loadSeeds(path: string): SeedSource[] {
  const data = seedSchema.parse(parse(readFileSync(path, "utf8")));
  const keys = new Set<string>();
  return data.sources.map((s) => {
    if (keys.has(s.key)) throw new Error(`duplicate source key ${s.key}`);
    keys.add(s.key);
    const d = data.defaults[s.tier] ?? { reliability: 0.6, focused: false };
    return { ...s, reliability: s.reliability ?? d.reliability, focused: s.focused ?? d.focused };
  });
}

/**
 * Upsert seeds. Editorial metadata follows the YAML; learned statistics and the
 * learned reliability (once the feedback loop has moved it) stay in the DB.
 */
export function syncSeeds(db: Db, seeds: SeedSource[]) {
  db.tx(() => {
    for (const s of seeds) {
      const existing = db.get<{ id: number; url: string; status: string }>("SELECT id, url, status FROM sources WHERE key = ?", s.key);
      if (!existing) {
        db.run(
          `INSERT INTO sources(key, name, kind, url, tier, side, country, lang, reliability, focused, config, enabled, origin, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'seed', ?)`,
          s.key, s.name, s.kind, s.url, s.tier, s.side, s.country, s.lang, s.reliability!, s.focused ? 1 : 0,
          JSON.stringify(s.config), s.enabled ? 1 : 0, nowIso(),
        );
      } else {
        db.run(
          `UPDATE sources SET name=?, kind=?, tier=?, side=?, country=?, lang=?, focused=?, config=?, enabled=? WHERE id=?`,
          s.name, s.kind, s.tier, s.side, s.country, s.lang, s.focused ? 1 : 0, JSON.stringify(s.config), s.enabled ? 1 : 0, existing.id,
        );
        // Respect a URL the health check recovered automatically unless the YAML changed it on purpose.
        if (existing.url !== s.url && existing.status !== "recovered") db.run("UPDATE sources SET url=? WHERE id=?", s.url, existing.id);
      }
    }
  });
}

export function activeSources(db: Db): SourceRow[] {
  return db.all<SourceRow>("SELECT * FROM sources WHERE enabled = 1 AND status IN ('active','testing','recovered') ORDER BY id");
}

export function sourceByDomain(db: Db): Map<string, { id: number; tier: string; side: string; reliability: number; name: string }> {
  const map = new Map<string, { id: number; tier: string; side: string; reliability: number; name: string }>();
  for (const s of db.all<{ id: number; url: string; tier: string; side: string; reliability: number; name: string; kind: string }>(
    "SELECT id, url, tier, side, reliability, name, kind FROM sources WHERE kind IN ('rss','web','bluesky')",
  )) {
    try {
      const host = new URL(s.url).hostname.replace(/^(www|feeds|rss|api|news|eng|rus|en)\./, "");
      if (!map.has(host)) map.set(host, s);
    } catch {
      /* skip */
    }
  }
  return map;
}
