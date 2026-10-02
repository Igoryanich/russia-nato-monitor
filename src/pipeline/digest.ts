import { z } from "zod";
import { effectiveMode } from "../admin/bot.ts";
import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import type { Llm } from "../llm.ts";
import { errMsg, log } from "../log.ts";
import { escapeHtml as e, hoursAgo, localDate, localHour, nowIso } from "../util.ts";
import type { Analysis } from "./analyze.ts";
import { visibleLength } from "./compose.ts";
import { indexOn, updateIndex } from "./escalation.ts";

const MILITARY = new Set([
  "force_movement", "military_buildup", "military_logistics", "exercise", "snap_exercise", "air_activity", "air_interception",
  "naval_activity", "nato_reinforcement", "us_force_posture", "military_readiness", "belarus_russia_integration", "mobilisation", "reservists",
]);

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const ruDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

const schema = z.object({
  summary_ru: z.string().transform((s) => s.trim().slice(0, 700)),
  watch: z.array(z.string().transform((s) => s.trim().slice(0, 40))).transform((a) => a.slice(0, 5)).catch([]),
});

interface Item {
  id: number;
  headline: string;
  url: string;
  signal: string;
  category: string;
  importance: number;
  region: string;
  confirmation: string;
}

export function digestItems(db: Db, sinceIso: string): Item[] {
  return db
    .all<{ id: number; analysis: string; importance: number; signal: string; category: string; region: string }>(
      `SELECT id, analysis, importance, signal, category, region FROM events
       WHERE analysis IS NOT NULL AND updated_at >= ? AND importance >= 40 AND status NOT IN ('rejected','merged')
         AND novelty NOT IN ('DUPLICATE','OLD_RESURFACED') ORDER BY importance DESC LIMIT 30`,
      sinceIso,
    )
    .map((r) => {
      const a = json<Analysis>(r.analysis, {} as Analysis);
      return {
        id: r.id, headline: a.headline_ru, url: a.primary_url ?? "", signal: r.signal, category: r.category,
        importance: r.importance, region: r.region ?? "", confirmation: a.confirmation_ru,
      };
    })
    .filter((i) => i.headline && i.url);
}

export function renderDigest(opts: {
  day: string;
  items: Item[];
  index: { today: number; yesterday: number | null; weekAgo: number | null };
  summary: string;
  watch: string[];
}): string {
  const { items, index } = opts;
  const line = (i: Item) => `• <a href="${e(i.url)}">${e(i.headline)}</a>`;
  const esc = items.filter((i) => i.signal === "escalation" && !MILITARY.has(i.category)).slice(0, 5);
  const mil = items.filter((i) => i.signal !== "counter" && MILITARY.has(i.category)).slice(0, 5);
  const cnt = items.filter((i) => i.signal === "counter").slice(0, 4);
  const other = items.filter((i) => i.signal === "neutral" && !MILITARY.has(i.category)).slice(0, 3);
  const delta = index.yesterday != null ? index.today - index.yesterday : null;
  const sections = [
    `<b>Россия—НАТО | Сводка за ${ruDate(opts.day)}</b>`,
    `Индекс эскалационных сигналов: <b>${index.today}</b>/100${delta != null ? ` (${delta >= 0 ? "+" : ""}${delta} за сутки)` : ""}${index.weekAgo != null ? ` · неделю назад ${index.weekAgo}` : ""}`,
  ];
  if (esc.length) sections.push(`🔴 <b>Эскалация</b>\n${esc.map(line).join("\n")}`);
  if (mil.length) sections.push(`🟠 <b>Военная активность</b>\n${mil.map(line).join("\n")}`);
  if (cnt.length) sections.push(`🟢 <b>Контрсигналы</b>\n${cnt.map(line).join("\n")}`);
  if (other.length) sections.push(`⚪️ <b>Заявления и политика</b>\n${other.map(line).join("\n")}`);
  if (!esc.length && !mil.length && !cnt.length && !other.length) sections.push("Существенных новых событий за сутки не зафиксировано.");
  if (opts.watch.length) sections.push(`🔎 <b>Наблюдаем</b>\n${opts.watch.map((w) => `• ${e(w)}`).join("\n")}`);
  sections.push(`<b>Что изменилось за сутки</b>\n${e(opts.summary)}`);
  sections.push("<i>Индекс отражает интенсивность наблюдаемых индикаторов за 7 дней, а не вероятность войны.</i>");
  let text = sections.join("\n\n");
  while (visibleLength(text) > 4000 && sections.length > 4) {
    sections.splice(sections.length - 4, 1);
    text = sections.join("\n\n");
  }
  return text;
}

export async function buildDigest(db: Db, llm: Llm, cfg: Config, day = localDate(cfg.TIMEZONE)): Promise<string> {
  const idx = updateIndex(db, cfg);
  const yesterday = localDate(cfg.TIMEZONE, new Date(Date.now() - 86400_000));
  const weekAgo = localDate(cfg.TIMEZONE, new Date(Date.now() - 7 * 86400_000));
  const items = digestItems(db, hoursAgo(24));
  let summary = "Нет данных для вывода.";
  let watch: string[] = [];
  try {
    const r = await llm.json({
      system: `Ты редактор мониторинга Россия—НАТО. По списку событий за сутки и динамике индекса напиши нейтральный вывод «Что изменилось за сутки» (2–4 коротких предложения, русский язык) СТРОГО на основании данных: что усилилось, что ослабло, какие есть контрсигналы. Не прогнозируй войну, не называй индекс вероятностью. Заявления сторон описывай как заявления. Также верни watch — 2–4 региона/направления, за которыми стоит следить (по-русски, коротко: «Калининград», «Балтийское море»). JSON: {"summary_ru": string, "watch": string[]}`,
      user: JSON.stringify({
        index: { today: idx.value, yesterday: indexOn(db, yesterday), week_ago: indexOn(db, weekAgo), drivers: idx.drivers, counter_signals: idx.counters },
        events: items.map((i) => ({ headline: i.headline, signal: i.signal, category: i.category, importance: i.importance, region: i.region, confirmation: i.confirmation })),
      }),
      schema,
      tier: "editor",
      maxTokens: 1500,
    });
    summary = r.summary_ru;
    watch = r.watch;
  } catch (err) {
    log.warn("digest summary failed", { err: errMsg(err) });
    watch = [...new Set(items.map((i) => i.region).filter(Boolean))].slice(0, 4);
    summary = items.length ? "Автоматический вывод недоступен; см. события выше." : "Существенных изменений не зафиксировано.";
  }
  return renderDigest({ day, items, index: { today: idx.value, yesterday: indexOn(db, yesterday), weekAgo: indexOn(db, weekAgo) }, summary, watch });
}

/** Once per local day, after DIGEST_HOUR_LOCAL. */
export async function maybeDigest(db: Db, llm: Llm, cfg: Config, force = false): Promise<string> {
  const day = localDate(cfg.TIMEZONE);
  const key = `digest:${day}`;
  const channel = cfg.TELEGRAM_CHANNEL_ID || "dry-run";
  if (!force && (localHour(cfg.TIMEZONE) < cfg.DIGEST_HOUR_LOCAL || db.get("SELECT 1 FROM publications WHERE key = ? AND channel = ?", key, channel)))
    return "not due";
  const text = await buildDigest(db, llm, cfg, day);
  db.run(
    `INSERT INTO publications(key, channel, kind, text, status, created_at, priority) VALUES(?,?,?,?,?,?,500)
     ON CONFLICT(key, channel) DO UPDATE SET text = excluded.text, status = excluded.status WHERE status IN ('review','pending')`,
    key, channel, "digest", text, effectiveMode(db, cfg) === "review" ? "review" : "pending", nowIso(),
  );
  if (effectiveMode(db, cfg) === "review" && cfg.TELEGRAM_ADMIN_CHAT_ID) {
    const pubId = db.get<{ id: number }>("SELECT id FROM publications WHERE key = ? AND channel = ?", key, channel)!.id;
    db.run(
      `INSERT OR IGNORE INTO publications(key, channel, kind, text, status, created_at, extra, priority) VALUES(?,?,?,?,?,?,?,100)`,
      `admin:${pubId}`, cfg.TELEGRAM_ADMIN_CHAT_ID, "admin", `🗂 <b>Сводка на проверку</b> #${pubId}\n\n${text}`.slice(0, 4000), "pending", nowIso(),
      JSON.stringify({ reply_markup: { inline_keyboard: [[{ text: "✅ Опубликовать", callback_data: `ap:${pubId}` }, { text: "❌ Отклонить", callback_data: `rj:${pubId}` }]] } }),
    );
  }
  return "built";
}
