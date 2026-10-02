import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { DomainResolver } from "../domains.ts";
import { effectiveMode } from "../admin/bot.ts";
import { log } from "../log.ts";
import { CATEGORY_RU, TIER_RU } from "../taxonomy.ts";
import { escapeHtml as e, nowIso } from "../util.ts";
import type { Analysis } from "./analyze.ts";
import { checkText, renderPost } from "./compose.ts";
import type { ImportanceBreakdown } from "./score.ts";

export interface Check {
  name: string;
  ok: boolean;
  hard: boolean; // hard failure ⇒ never published; soft ⇒ human review
  detail?: string;
}

interface EventRow {
  id: number;
  analysis: string;
  importance: number;
  importance_factors: string;
  independent_count: number;
  best_tier: string | null;
  published_version: number;
  event_date: string | null;
  status: string;
}

export function editorialChecks(ev: EventRow, a: Analysis, cfg: Config, today = new Date()): Check[] {
  const isUpdate = ev.published_version > 0;
  const oldest = new Date(today.getTime() - 3 * 86400_000).toISOString().slice(0, 10);
  const date = a.event_date ?? ev.event_date;
  const text = checkText(a);
  const checks: Check[] = [
    { name: "Релевантно теме Россия—НАТО", ok: a.relevant, hard: true },
    {
      name: isUpdate ? "Существенное обновление" : "Новое событие",
      ok: isUpdate ? a.novelty === "SIGNIFICANT_UPDATE" : a.novelty === "NEW_EVENT" || a.novelty === "SIGNIFICANT_UPDATE",
      hard: true,
      detail: `${a.novelty}: ${a.novelty_reason}`,
    },
    { name: "Не дубликат опубликованного", ok: a.duplicate_of == null, hard: true, detail: a.duplicate_of ? `дубликат #${a.duplicate_of}` : undefined },
    { name: `Важность ≥ ${cfg.PUBLISH_THRESHOLD}`, ok: ev.importance >= cfg.PUBLISH_THRESHOLD, hard: true, detail: `${ev.importance}/100` },
    { name: "Дата события свежая", ok: !date || date >= oldest, hard: true, detail: date ?? "не указана" },
    { name: "Есть ссылка на источник", ok: a.source_urls.length > 0, hard: true },
    { name: "Не только соцсети/анонимные", ok: ev.best_tier !== "G", hard: false, detail: ev.best_tier ? TIER_RU[ev.best_tier] : undefined },
    { name: "Заголовок не преувеличивает доказательства", ok: !a.headline_risk, hard: false },
    { name: "Заявления не выданы за факты", ok: !text.some((t) => t.code === "claim_as_fact"), hard: false, detail: text.find((t) => t.code === "claim_as_fact")?.detail },
    { name: "Нет точных координат", ok: !text.some((t) => t.code === "coordinates"), hard: false },
    { name: "Текст корректен (русский, без ссылок)", ok: !text.some((t) => ["generated_link", "not_russian", "short_headline"].includes(t.code)), hard: true, detail: text.map((t) => t.detail).join("; ") || undefined },
  ];
  return checks;
}

export function adminPreview(eventId: number, a: Analysis, imp: ImportanceBreakdown, checks: Check[], post: string): string {
  const parts = Object.entries(imp.parts)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} +${v}`)
    .join(", ");
  const failed = checks.filter((c) => !c.ok).map((c) => `⚠️ ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  const stmts = a.statements.map((s) => `• [${s.type}] ${s.text_ru} — ${s.attributed_to}`).join("\n");
  return [
    `🗂 <b>На проверку</b> · событие #${eventId} · ${e(CATEGORY_RU[a.category] ?? a.category)} · важность ${imp.total}`,
    `<b>Почему:</b> ${e(parts)}${imp.caps.length ? `; ограничения: ${e(imp.caps.join(", "))}` : ""}`,
    failed.length ? e(failed.join("\n")) : "✅ Все проверки пройдены",
    stmts ? `<b>Утверждения:</b>\n${e(stmts)}` : "",
    "— — — предпросмотр — — —",
    post,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);
}

/** Decide what to do with freshly analysed events and queue posts. */
export function queuePublications(db: Db, cfg: Config): { queued: number; review: number; background: number } {
  const resolver = new DomainResolver(db);
  const channel = cfg.TELEGRAM_CHANNEL_ID || "dry-run";
  const mode = effectiveMode(db, cfg);
  const rows = db.all<EventRow>(
    `SELECT id, analysis, importance, importance_factors, independent_count, best_tier, published_version, event_date, status
     FROM events WHERE analysis IS NOT NULL AND needs_analysis = 0 AND status IN ('analyzed','published','review','queued') AND importance IS NOT NULL`,
  );
  let queued = 0;
  let review = 0;
  let background = 0;
  for (const ev of rows) {
    const a = json<Analysis | null>(ev.analysis, null);
    if (!a) continue;
    const version = ev.published_version + 1;
    const key = `event:${ev.id}:v${version}`;
    const existing = db.get<{ id: number; status: string }>("SELECT id, status FROM publications WHERE key = ? AND channel = ?", key, channel);
    // Already decided (sent / cancelled / failed …): nothing to do. Still waiting: refresh it with the latest analysis.
    if (existing && !["review", "pending"].includes(existing.status)) continue;
    const checks = editorialChecks(ev, a, cfg);
    const hardFail = checks.some((c) => c.hard && !c.ok);
    const note = JSON.stringify(checks);
    if (hardFail) {
      if (existing) db.run("UPDATE publications SET status = 'cancelled', error = 'failed editorial checks after re-analysis' WHERE id = ?", existing.id);
      // Published events keep their status; unpublished ones fall back to background.
      if (ev.status === "analyzed") {
        db.run("UPDATE events SET status = ?, review_note = ? WHERE id = ?", a.relevant ? "background" : "rejected", note, ev.id);
        background++;
      }
      continue;
    }
    const imp = json<ImportanceBreakdown>(ev.importance_factors, { total: ev.importance, parts: {}, caps: [] });
    const breaking =
      ev.importance >= cfg.BREAKING_THRESHOLD && a.confidence >= 0.8 && ev.independent_count >= 2 && (ev.best_tier === "A" || ev.best_tier === "B");
    let post: string;
    try {
      post = renderPost({ a, importance: ev.importance, breaking, isUpdate: ev.published_version > 0, resolver });
    } catch (err) {
      db.run("UPDATE events SET status = 'background', review_note = ? WHERE id = ?", `render failed: ${(err as Error).message}`, ev.id);
      continue;
    }
    const soft = checks.some((c) => !c.hard && !c.ok);
    const needsReview = soft || mode === "review";
    if (existing) {
      db.run("UPDATE publications SET text = ?, priority = MAX(priority, ?) WHERE id = ?", post, ev.importance, existing.id);
      db.run("UPDATE events SET review_note = ? WHERE id = ?", note, ev.id);
      continue;
    }
    const original = ev.published_version > 0
      ? db.get<{ message_id: number }>("SELECT message_id FROM publications WHERE event_id = ? AND channel = ? AND status = 'sent' AND kind != 'admin' ORDER BY id LIMIT 1", ev.id, channel)
      : undefined;
    const extra = original?.message_id ? { reply_parameters: { message_id: original.message_id, allow_sending_without_reply: true } } : {};
    const pubId = Number(
      db.run(
        `INSERT INTO publications(key, channel, event_id, kind, text, status, created_at, extra, priority) VALUES(?,?,?,?,?,?,?,?,?)`,
        key, channel, ev.id, ev.published_version > 0 ? "update" : breaking ? "breaking" : "post", post,
        needsReview ? "review" : "pending", nowIso(), JSON.stringify(extra), ev.importance,
      ).lastInsertRowid,
    );
    db.run("UPDATE events SET status = ?, review_note = ? WHERE id = ?", needsReview && ev.status !== "published" ? "review" : ev.status === "published" ? "published" : "queued", note, ev.id);
    if (needsReview) {
      review++;
      if (cfg.TELEGRAM_ADMIN_CHAT_ID) {
        db.run(
          `INSERT OR IGNORE INTO publications(key, channel, event_id, kind, text, status, created_at, extra, priority) VALUES(?,?,?,?,?,?,?,?,?)`,
          `admin:${pubId}`, cfg.TELEGRAM_ADMIN_CHAT_ID, ev.id, "admin", adminPreview(ev.id, a, imp, checks, post), "pending", nowIso(),
          JSON.stringify({
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Опубликовать", callback_data: `ap:${pubId}` },
                { text: "❌ Отклонить", callback_data: `rj:${pubId}` },
              ]],
            },
          }),
          100,
        );
      }
    } else queued++;
  }
  log.info("editorial done", { queued, review, background });
  return { queued, review, background };
}
