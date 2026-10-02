import { z } from "zod";
import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import type { Llm } from "../llm.ts";
import { errMsg, log } from "../log.ts";
import { hoursAgo } from "../util.ts";
import type { Analysis } from "./analyze.ts";

const schema = z.object({
  hold: z
    .array(z.object({ id: z.coerce.number().int(), reason: z.string().transform((s) => s.slice(0, 200)) }))
    .catch([]),
});

/**
 * Last line of defence against repetition before anything reaches the channel:
 * clustering can under-merge (e.g. while the embedding quota is exhausted), so one
 * cheap call compares queued posts with each other and with posts already sent in
 * the last 48 h. Per story only the most informative queued post survives.
 */
export async function storyGuard(db: Db, llm: Llm, cfg: Config): Promise<{ checked: number; held: number; error?: string }> {
  const channel = cfg.TELEGRAM_CHANNEL_ID || "dry-run";
  const queued = db.all<{ id: number; event_id: number; priority: number; analysis: string }>(
    `SELECT p.id, p.event_id, p.priority, e.analysis FROM publications p JOIN events e ON e.id = p.event_id
     WHERE p.channel = ? AND p.status = 'pending' AND p.kind IN ('post','breaking') ORDER BY p.priority DESC`,
    channel,
  );
  if (!queued.length || !llm.enabled) return { checked: 0, held: 0 };
  const sent = db.all<{ analysis: string }>(
    `SELECT e.analysis FROM publications p JOIN events e ON e.id = p.event_id
     WHERE p.channel = ? AND p.status = 'sent' AND p.kind IN ('post','breaking','update') AND p.sent_at >= ?`,
    channel, hoursAgo(48),
  );
  const head = (a: string) => {
    const x = json<Analysis | null>(a, null);
    return x ? `${x.headline_ru} — ${x.what_ru.slice(0, 220)}` : "";
  };
  let result: z.infer<typeof schema>;
  try {
    result = await llm.json({
      system: `Ты выпускающий редактор Telegram-канала. Ниже очередь постов (queued, по убыванию важности) и уже опубликованные за 48 часов (published).
Найди посты из queued, которые рассказывают ТУ ЖЕ историю, что другой пост из queued или из published (тот же инцидент, то же заявление/документ, та же реакция на него — даже если источник или формулировка другие).
Правило: если история уже есть в published — снять пост из queued. Если несколько queued об одной истории — оставить один, самый информативный (обычно первый по важности), остальные снять.
Разные события в одной теме (например, разные учения или разные инциденты) — НЕ дубликаты.
Верни JSON {"hold": [{"id": <id из queued>, "reason": "коротко по-русски"}]}. Если снимать нечего — {"hold": []}.`,
      user: JSON.stringify({
        queued: queued.map((q) => ({ id: q.id, importance: q.priority, text: head(q.analysis) })),
        published: sent.map((s) => head(s.analysis)).filter(Boolean),
      }),
      schema,
      tier: "cheap",
      maxTokens: 1500,
    });
  } catch (e) {
    // Without the guard we would rather wait a cycle than flood the channel with repeats.
    log.warn("story guard failed — holding the queue until next run", { err: errMsg(e) });
    db.run(
      "UPDATE publications SET retry_at = ? WHERE channel = ? AND status = 'pending' AND kind IN ('post','breaking')",
      new Date(Date.now() + 30 * 60_000).toISOString(), channel,
    );
    return { checked: queued.length, held: 0, error: errMsg(e) };
  }
  const ids = new Set(queued.map((q) => q.id));
  let held = 0;
  for (const h of result.hold) {
    if (!ids.has(h.id)) continue;
    const q = queued.find((x) => x.id === h.id)!;
    db.run("UPDATE publications SET status = 'cancelled', error = ? WHERE id = ?", `story duplicate: ${h.reason}`, h.id);
    db.run("UPDATE events SET status = 'background', review_note = ? WHERE id = ? AND published_version = 0", JSON.stringify([{ name: "Не повтор уже освещённой истории", ok: false, hard: true, detail: h.reason }]), q.event_id);
    held++;
  }
  log.info("story guard", { checked: queued.length, held });
  return { checked: queued.length, held };
}
