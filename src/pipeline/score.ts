import { type Db, json } from "../db.ts";
import { TIER_WEIGHT } from "../sources.ts";
import { CATEGORY_WEIGHT, type Category } from "../taxonomy.ts";
import { clamp } from "../util.ts";
import type { Analysis } from "./analyze.ts";

export interface ImportanceBreakdown {
  total: number;
  parts: Record<string, number>; // contribution in points
  caps: string[]; // why the score was capped
}

const NOVELTY_VALUE: Record<string, number> = {
  NEW_EVENT: 1, SIGNIFICANT_UPDATE: 0.8, MINOR_UPDATE: 0.2, BACKGROUND: 0.1, DUPLICATE: 0, OLD_RESURFACED: 0,
};

/**
 * Importance 0–100: how much this event matters for the Russia–NATO picture.
 * NOT a probability of war. Every point is attributable to a named component.
 */
export function computeImportance(
  a: Pick<Analysis, "factors" | "confidence" | "novelty" | "relevant">,
  ev: { best_tier: string | null; independent_count: number; sides: string[] },
): ImportanceBreakdown {
  const f = a.factors;
  const sourcing = TIER_WEIGHT[ev.best_tier ?? "G"] ?? 0.25;
  const corroboration = clamp((ev.independent_count - 1) / 3, 0, 1);
  const raw: Record<string, number> = {
    "военная значимость": 22 * f.military_significance,
    "прямое отношение Россия—НАТО": 18 * f.direct_relevance,
    "география (линия соприкосновения)": 12 * f.geographic_significance,
    "отличие от фона": 10 * f.baseline_change,
    "официальное участие": 10 * f.official_involvement,
    "надёжность источников": 13 * sourcing,
    "независимые подтверждения": 10 * corroboration,
    "новизна": 5 * (NOVELTY_VALUE[a.novelty] ?? 0),
  };
  const base = Object.values(raw).reduce((s, v) => s + v, 0);
  const confMul = 0.6 + 0.4 * a.confidence;
  let total = base * confMul;
  const caps: string[] = [];
  if (!a.relevant) {
    total = Math.min(total, 15);
    caps.push("нерелевантно теме");
  }
  if (a.novelty === "DUPLICATE" || a.novelty === "OLD_RESURFACED") {
    total = Math.min(total, 10);
    caps.push(a.novelty === "DUPLICATE" ? "дубликат" : "старое событие");
  } else if (a.novelty === "BACKGROUND") {
    total = Math.min(total, 40);
    caps.push("фоновый материал");
  } else if (a.novelty === "MINOR_UPDATE") {
    total = Math.min(total, 45);
    caps.push("незначительное обновление");
  }
  if (ev.best_tier === "G") {
    total = Math.min(total, 45);
    caps.push("только соцсети/анонимные источники");
  }
  const parts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round(v * confMul * 10) / 10]));
  return { total: Math.round(clamp(total, 0, 100)), parts, caps };
}

export function scoreEvent(db: Db, eventId: number) {
  const ev = db.get<{ analysis: string; best_tier: string; independent_count: number; sides: string; category: string; signal: string }>(
    "SELECT analysis, best_tier, independent_count, sides, category, signal FROM events WHERE id = ?",
    eventId,
  );
  const a = json<Analysis | null>(ev?.analysis, null);
  if (!ev || !a) return;
  const b = computeImportance(a, { best_tier: ev.best_tier, independent_count: ev.independent_count, sides: json(ev.sides, []) });
  // Contribution to the escalation index: signed, before time decay.
  const w = (CATEGORY_WEIGHT[a.category as Category] ?? 0.1) * (b.total / 100) * (0.5 + 0.5 * a.confidence);
  const signed = a.signal === "escalation" ? w : a.signal === "counter" ? -w : 0;
  db.run(
    "UPDATE events SET importance = ?, importance_factors = ?, escalation_weight = ? WHERE id = ?",
    b.total, JSON.stringify(b), Math.round(signed * 1000) / 1000, eventId,
  );
}
