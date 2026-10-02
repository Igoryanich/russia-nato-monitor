import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { errMsg, log } from "../log.ts";
import type { Analysis } from "../pipeline/analyze.ts";
import type { Check } from "../pipeline/editorial.ts";
import type { ImportanceBreakdown } from "../pipeline/score.ts";
import { CATEGORY_RU } from "../taxonomy.ts";
import type { Telegram } from "../telegram.ts";
import { escapeHtml as e, hoursAgo } from "../util.ts";

export function effectiveMode(db: Db, cfg: Config): "auto" | "review" {
  const m = db.kvGet("publish_mode");
  return m === "auto" || m === "review" ? m : cfg.PUBLISH_MODE;
}

export function approve(db: Db, pubId: number): string {
  const p = db.get<{ status: string; event_id: number }>("SELECT status, event_id FROM publications WHERE id = ?", pubId);
  if (!p) return `Публикация #${pubId} не найдена`;
  if (p.status !== "review") return `Публикация #${pubId} уже в статусе ${p.status}`;
  db.run("UPDATE publications SET status = 'pending', priority = priority + 1000 WHERE id = ?", pubId);
  db.run("UPDATE events SET status = CASE WHEN status = 'review' THEN 'queued' ELSE status END WHERE id = ?", p.event_id);
  return `✅ #${pubId} одобрено — уйдёт в канал в ближайшем цикле`;
}

export function reject(db: Db, pubId: number): string {
  const p = db.get<{ status: string; event_id: number }>("SELECT status, event_id FROM publications WHERE id = ?", pubId);
  if (!p) return `Публикация #${pubId} не найдена`;
  if (!["review", "pending"].includes(p.status)) return `Публикация #${pubId} уже в статусе ${p.status}`;
  db.run("UPDATE publications SET status = 'cancelled' WHERE id = ?", pubId);
  db.run("UPDATE events SET status = CASE WHEN published_version = 0 THEN 'rejected' ELSE status END WHERE id = ?", p.event_id);
  return `❌ #${pubId} отклонено`;
}

export function explainEvent(db: Db, eventId: number): string {
  const ev = db.get<{ analysis: string; importance: number; importance_factors: string; review_note: string; independent_count: number; best_tier: string; status: string; origins: string }>(
    "SELECT analysis, importance, importance_factors, review_note, independent_count, best_tier, status, origins FROM events WHERE id = ?",
    eventId,
  );
  if (!ev) return `Событие #${eventId} не найдено`;
  const a = json<Analysis | null>(ev.analysis, null);
  const imp = json<ImportanceBreakdown>(ev.importance_factors, { total: ev.importance, parts: {}, caps: [] });
  const checks = json<Check[]>(ev.review_note, []);
  const arts = db.all<{ url: string; name: string; tier: string }>(
    "SELECT a.url, s.name, s.tier FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.event_id = ? ORDER BY a.collected_at LIMIT 8",
    eventId,
  );
  return [
    `<b>#${eventId}</b> ${e(a?.headline_ru ?? "(не проанализировано)")}`,
    `Статус: ${ev.status} · важность ${ev.importance ?? "—"} · независимых источников ${ev.independent_count} · лучший tier ${ev.best_tier}`,
    a ? `Категория: ${e(CATEGORY_RU[a.category] ?? a.category)} · сигнал: ${a.signal} · новизна: ${a.novelty} · уверенность ${a.confidence}` : "",
    Object.keys(imp.parts).length ? `<b>Из чего важность:</b>\n${Object.entries(imp.parts).map(([k, v]) => `• ${e(k)}: +${v}`).join("\n")}` : "",
    imp.caps.length ? `Ограничения: ${e(imp.caps.join(", "))}` : "",
    checks.length ? `<b>Проверки:</b>\n${checks.map((c) => `${c.ok ? "✅" : c.hard ? "⛔" : "⚠️"} ${e(c.name)}${c.detail ? ` — ${e(c.detail)}` : ""}`).join("\n")}` : "",
    `<b>Источники (${json<string[]>(ev.origins, []).length} независимых):</b>\n${arts.map((x) => `• [${x.tier}] <a href="${e(x.url)}">${e(x.name)}</a>`).join("\n")}`,
  ].filter(Boolean).join("\n\n").slice(0, 4000);
}

function statusText(db: Db, cfg: Config): string {
  const run = db.get<{ started_at: string; stats: string }>("SELECT started_at, stats FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1");
  const idx = db.get<{ day: string; value: number }>("SELECT day, value FROM index_history ORDER BY day DESC LIMIT 1");
  const c = (sql: string, ...p: string[]) => db.get<{ n: number }>(sql, ...p)?.n ?? 0;
  return [
    `<b>Состояние</b> · режим: ${effectiveMode(db, cfg)}${cfg.DRY_RUN ? " · DRY_RUN" : ""}`,
    `Последний цикл: ${run?.started_at.slice(0, 16) ?? "—"}`,
    `Индекс эскалационных сигналов: ${idx ? `${idx.value} (${idx.day})` : "—"}`,
    `На проверке: ${c("SELECT COUNT(*) n FROM publications WHERE status = 'review'")} · в очереди: ${c("SELECT COUNT(*) n FROM publications WHERE status = 'pending' AND kind != 'admin'")} · неопределённых отправок: ${c("SELECT COUNT(*) n FROM publications WHERE status = 'uncertain'")}`,
    `События за 24ч: ${c("SELECT COUNT(*) n FROM events WHERE created_at >= ?", hoursAgo(24))} · опубликовано: ${c("SELECT COUNT(*) n FROM events WHERE published_at >= ?", hoursAgo(24))}`,
    `Источники: ${c("SELECT COUNT(*) n FROM sources WHERE enabled = 1 AND status IN ('active','recovered')")} активных · ${c("SELECT COUNT(*) n FROM sources WHERE status = 'testing'")} на испытании · ${c("SELECT COUNT(*) n FROM sources WHERE status = 'dead'")} мёртвых`,
    `Кандидаты в источники: ${c("SELECT COUNT(*) n FROM source_candidates WHERE status IN ('new','no_feed')")}`,
  ].join("\n");
}

function pendingText(db: Db): string {
  const rows = db.all<{ id: number; event_id: number; priority: number; headline: string }>(
    `SELECT p.id, p.event_id, p.priority, json_extract(e.analysis, '$.headline_ru') AS headline FROM publications p
     JOIN events e ON e.id = p.event_id WHERE p.status = 'review' AND p.kind != 'admin' ORDER BY p.priority DESC LIMIT 15`,
  );
  if (!rows.length) return "Нет материалов на проверке.";
  return rows.map((r) => `#${r.id} (событие ${r.event_id}, ${r.priority}) ${e(r.headline ?? "")}\n/approve_${r.id}  /reject_${r.id}  /why_${r.event_id}`).join("\n\n");
}

function sourcesText(db: Db): string {
  const bad = db.all<{ key: string; status: string; consecutive_failures: number; last_error: string | null }>(
    "SELECT key, status, consecutive_failures, last_error FROM sources WHERE enabled = 1 AND (consecutive_failures >= 3 OR status IN ('dead','testing')) ORDER BY consecutive_failures DESC LIMIT 15",
  );
  const best = db.all<{ key: string; relevant_items: number; first_reports: number; reliability: number }>(
    "SELECT key, relevant_items, first_reports, reliability FROM sources ORDER BY first_reports DESC, relevant_items DESC LIMIT 10",
  );
  return [
    "<b>Лучшие источники</b> (первыми / релевантных / надёжность):",
    ...best.map((s) => `• ${e(s.key)}: ${s.first_reports} / ${s.relevant_items} / ${s.reliability.toFixed(2)}`),
    "",
    "<b>Требуют внимания:</b>",
    ...(bad.length ? bad.map((s) => `• ${e(s.key)} [${s.status}] сбоев ${s.consecutive_failures}${s.last_error ? ` — ${e(s.last_error.slice(0, 60))}` : ""}`) : ["нет"]),
  ].join("\n");
}

function candidatesText(db: Db): string {
  const rows = db.all<{ domain: string; mentions: number; original_mentions: number; feed_url: string | null; status: string }>(
    "SELECT domain, mentions, original_mentions, feed_url, status FROM source_candidates WHERE status IN ('new','no_feed') ORDER BY original_mentions DESC, mentions DESC LIMIT 15",
  );
  if (!rows.length) return "Кандидатов пока нет.";
  return rows
    .map((r) => `• ${e(r.domain)} — упоминаний ${r.mentions}, как первоисточник ${r.original_mentions}${r.feed_url ? " · есть RSS" : ""} [${r.status}]\n  /promote ${e(r.domain)} · /block ${e(r.domain)}`)
    .join("\n");
}

const HELP = `Команды:
/status — состояние системы
/pending — материалы на проверке
/approve N, /reject N — решение по публикации N
/why N — почему событие N получило такую оценку
/sources — здоровье и рейтинг источников
/candidates — новые найденные источники
/promote домен, /block домен — решение по кандидату
/mode auto | review — режим публикации`;

export async function handleCommand(db: Db, cfg: Config, text: string): Promise<string> {
  const m = /^\/(\w+?)(?:@\w+)?(?:[_ ](\S+))?\s*$/.exec(text.trim());
  if (!m) return HELP;
  const [, cmd, arg] = m;
  const n = Number(arg);
  switch (cmd) {
    case "status": return statusText(db, cfg);
    case "pending": return pendingText(db);
    case "approve": return Number.isInteger(n) ? approve(db, n) : "Укажите номер: /approve 12";
    case "reject": return Number.isInteger(n) ? reject(db, n) : "Укажите номер: /reject 12";
    case "why": return Number.isInteger(n) ? explainEvent(db, n) : "Укажите номер события: /why 5";
    case "sources": return sourcesText(db);
    case "candidates": return candidatesText(db);
    case "promote":
    case "block": {
      if (!arg) return `Укажите домен: /${cmd} example.com`;
      const { promoteCandidate, blockCandidate } = await import("../pipeline/discovery.ts");
      return cmd === "promote" ? promoteCandidate(db, arg, "admin") : blockCandidate(db, arg);
    }
    case "mode":
      if (arg !== "auto" && arg !== "review") return `Сейчас: ${effectiveMode(db, cfg)}. Использование: /mode auto | /mode review`;
      db.kvSet("publish_mode", arg);
      return `Режим публикации: ${arg}`;
    default: return HELP;
  }
}

/** Process admin messages and button presses accumulated since the last cycle. */
export async function pollAdmin(db: Db, cfg: Config, tg: Telegram): Promise<number> {
  if (!cfg.TELEGRAM_ADMIN_CHAT_ID) return 0;
  const offset = Number(db.kvGet("tg_offset") ?? 0);
  let updates: any[];
  try {
    updates = await tg.call("getUpdates", { offset, timeout: 0, allowed_updates: ["message", "callback_query"] });
  } catch (err) {
    log.warn("getUpdates failed", { err: errMsg(err) });
    return 0;
  }
  let handled = 0;
  for (const u of updates) {
    db.kvSet("tg_offset", String(u.update_id + 1));
    try {
      if (u.callback_query) {
        const q = u.callback_query;
        if (String(q.message?.chat?.id) !== cfg.TELEGRAM_ADMIN_CHAT_ID) continue;
        const [act, id] = String(q.data ?? "").split(":");
        const reply = act === "ap" ? approve(db, Number(id)) : act === "rj" ? reject(db, Number(id)) : "?";
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: reply.slice(0, 190) });
        await tg.call("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await tg.send(cfg.TELEGRAM_ADMIN_CHAT_ID, e(reply), { reply_parameters: { message_id: q.message.message_id } });
        handled++;
      } else if (u.message?.text) {
        if (String(u.message.chat.id) !== cfg.TELEGRAM_ADMIN_CHAT_ID) continue; // the bot answers its editor only
        await tg.send(cfg.TELEGRAM_ADMIN_CHAT_ID, await handleCommand(db, cfg, u.message.text));
        handled++;
      }
    } catch (err) {
      log.warn("admin update failed", { err: errMsg(err) });
    }
  }
  return handled;
}
