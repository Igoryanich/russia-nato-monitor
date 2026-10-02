import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { effectiveMode } from "./admin/bot.ts";
import type { Config } from "./config.ts";
import { type Db, json } from "./db.ts";
import type { Analysis } from "./pipeline/analyze.ts";
import type { Check } from "./pipeline/editorial.ts";
import type { ImportanceBreakdown } from "./pipeline/score.ts";
import { CATEGORY_RU } from "./taxonomy.ts";
import { escapeHtml as e, hoursAgo } from "./util.ts";

const tgToHtml = (s: string) => s.replace(/\n/g, "<br>");

/** A single static page for the editor: events, why they scored, queue, sources, candidates. */
export function writeReport(db: Db, cfg: Config, path: string): string {
  const events = db.all<{
    id: number; status: string; importance: number | null; analysis: string | null; importance_factors: string | null; review_note: string | null;
    independent_count: number; best_tier: string | null; created_at: string; category: string | null; signal: string | null; title: string; article_count: number;
  }>(
    `SELECT id, status, importance, analysis, importance_factors, review_note, independent_count, best_tier, created_at, category, signal, title, article_count
     FROM events WHERE updated_at >= ? AND status != 'merged' ORDER BY COALESCE(importance, -1) DESC, id DESC LIMIT 150`,
    hoursAgo(72),
  );
  const pubs = db.all<{ id: number; kind: string; status: string; text: string; event_id: number | null; created_at: string; sent_at: string | null; error: string | null }>(
    "SELECT id, kind, status, text, event_id, created_at, sent_at, error FROM publications WHERE kind != 'admin' ORDER BY id DESC LIMIT 40",
  );
  const idx = db.all<{ day: string; value: number; drivers: string; counters: string }>("SELECT * FROM index_history ORDER BY day DESC LIMIT 30");
  const sources = db.all<{ key: string; name: string; tier: string; side: string; kind: string; status: string; origin: string; consecutive_failures: number; total_items: number; relevant_items: number; first_reports: number; confirmed_reports: number; reliability: number; last_item_at: string | null; last_error: string | null }>(
    "SELECT * FROM sources WHERE enabled = 1 OR status = 'dead' ORDER BY relevant_items DESC",
  );
  const cands = db.all<{ domain: string; mentions: number; original_mentions: number; status: string; feed_url: string | null; note: string | null; names: string }>(
    "SELECT * FROM source_candidates ORDER BY original_mentions DESC, mentions DESC LIMIT 40",
  );
  const runs = db.all<{ started_at: string; finished_at: string | null; stats: string | null }>("SELECT * FROM runs ORDER BY id DESC LIMIT 8");
  const usage = db.all<{ day: string; model: string; calls: number; failures: number }>("SELECT day, model, calls, failures FROM llm_usage ORDER BY day DESC LIMIT 12");

  const today = idx[0];
  const spark = idx.slice().reverse().map((r) => `<span title="${r.day}: ${r.value}" style="height:${Math.max(2, r.value)}%"></span>`).join("");

  const eventRows = events.map((ev) => {
    const a = json<Analysis | null>(ev.analysis, null);
    const imp = json<ImportanceBreakdown | null>(ev.importance_factors, null);
    const checks = json<Check[]>(ev.review_note, []);
    const failed = checks.filter((c) => !c.ok);
    const why = imp ? Object.entries(imp.parts).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} +${v}`).join(", ") : "";
    return `<tr class="st-${ev.status}">
      <td>#${ev.id}</td><td><b>${ev.importance ?? "—"}</b></td><td><span class="pill">${ev.status}</span></td>
      <td>${e(a?.headline_ru ?? ev.title)}<div class="muted">${e(CATEGORY_RU[(a?.category ?? ev.category) as keyof typeof CATEGORY_RU] ?? ev.category ?? "")} · ${e(a?.signal ?? ev.signal ?? "")} · ${e(a?.novelty ?? "")} · статей ${ev.article_count}, независимых ${ev.independent_count}, tier ${ev.best_tier ?? "—"}</div>
      ${why ? `<div class="why">Почему: ${e(why)}${imp?.caps.length ? ` · ограничения: ${e(imp.caps.join(", "))}` : ""}</div>` : ""}
      ${failed.length ? `<div class="fail">${failed.map((c) => `${c.hard ? "⛔" : "⚠️"} ${e(c.name)}${c.detail ? ` — ${e(c.detail)}` : ""}`).join("<br>")}</div>` : ""}
      ${a?.statements.length ? `<details><summary>утверждения</summary>${a.statements.map((s) => `<div>[${s.type}] ${e(s.text_ru)} — <i>${e(s.attributed_to)}</i></div>`).join("")}</details>` : ""}</td></tr>`;
  });

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Russia–NATO Monitor</title><style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e4e1d8;--card:#fff;--accent:#b4441c;--ok:#2f7d4f;--warn:#a86b00}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--muted:#9a988f;--line:#2c2b27;--card:#1c1b19;--accent:#e0794f;--ok:#6cc08f;--warn:#e0b04f}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1200px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
.muted{color:var(--muted);font-size:12px}.why{font-size:12px;color:var(--ok)}.fail{font-size:12px;color:var(--warn)}
.pill{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:1px 6px;white-space:nowrap}
.spark{display:flex;align-items:flex-end;gap:2px;height:60px;border-bottom:1px solid var(--line)}.spark span{width:10px;background:var(--accent);display:block}
.post{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0}
.wrap{overflow-x:auto}a{color:var(--accent)}.big{font-size:32px;font-weight:700}
</style></head><body>
<h1>Russia–NATO Monitor — редакционный отчёт</h1>
<div class="muted">Сформирован ${new Date().toISOString().slice(0, 16)} UTC · режим ${effectiveMode(db, cfg)}${cfg.DRY_RUN ? " · DRY_RUN" : ""}</div>
<h2>Индекс эскалационных сигналов</h2>
<div class="big">${today?.value ?? "—"}<span class="muted" style="font-size:14px"> /100 · ${today?.day ?? ""} · не вероятность войны</span></div>
<div class="spark">${spark}</div>
${today ? `<div class="wrap"><b>Драйверы:</b> ${json<{ headline: string; contribution: number }[]>(today.drivers, []).map((d) => `${e(d.headline)} (+${d.contribution})`).join("; ") || "—"}<br><b>Контрсигналы:</b> ${json<{ headline: string; contribution: number }[]>(today.counters, []).map((d) => `${e(d.headline)} (−${d.contribution})`).join("; ") || "—"}</div>` : ""}
<h2>События за 72 часа (${events.length})</h2><div class="wrap"><table><tr><th>#</th><th>Важн.</th><th>Статус</th><th>Событие / почему</th></tr>${eventRows.join("")}</table></div>
<h2>Публикации</h2>${pubs.map((p) => `<div class="post"><div class="muted">#${p.id} · ${p.kind} · <b>${p.status}</b> · ${p.created_at.slice(0, 16)}${p.sent_at ? ` · отправлено ${p.sent_at.slice(0, 16)}` : ""}${p.error ? ` · ${e(p.error)}` : ""}${p.status === "review" ? ` · одобрить: <code>/approve ${p.id}</code>` : ""}</div>${tgToHtml(p.text)}</div>`).join("") || "<p class=muted>Пока нет.</p>"}
<h2>Кандидаты в источники</h2><div class="wrap"><table><tr><th>Домен</th><th>Упоминаний</th><th>Первоисточник</th><th>Статус</th><th>RSS / заметка</th></tr>
${cands.map((c) => `<tr><td>${e(c.domain)}</td><td>${c.mentions}</td><td>${c.original_mentions}</td><td>${c.status}</td><td class="muted">${e(c.feed_url ?? "")} ${e(c.note ?? "")}</td></tr>`).join("")}</table></div>
<h2>Источники (${sources.length})</h2><div class="wrap"><table><tr><th>Источник</th><th>Tier</th><th>Сторона</th><th>Статус</th><th>Статей</th><th>Релев.</th><th>Первым</th><th>Подтв.</th><th>Надёжн.</th><th>Последний материал</th></tr>
${sources.map((s) => `<tr><td>${e(s.name)} <span class="muted">${e(s.key)} · ${s.kind}${s.origin !== "seed" ? ` · ${s.origin}` : ""}</span>${s.consecutive_failures ? `<div class="fail">сбоев подряд ${s.consecutive_failures}: ${e(s.last_error ?? "")}</div>` : ""}</td><td>${s.tier}</td><td>${s.side}</td><td>${s.status}</td><td>${s.total_items}</td><td>${s.relevant_items}</td><td>${s.first_reports}</td><td>${s.confirmed_reports}</td><td>${s.reliability.toFixed(2)}</td><td class="muted">${(s.last_item_at ?? "").slice(0, 10)}</td></tr>`).join("")}</table></div>
<h2>Последние циклы</h2>${runs.map((r) => `<details><summary>${r.started_at.slice(0, 16)} → ${(r.finished_at ?? "…").slice(11, 16)}</summary><pre class="muted" style="white-space:pre-wrap">${e(JSON.stringify(json(r.stats, {}), null, 1))}</pre></details>`).join("")}
<h2>LLM</h2><table>${usage.map((u) => `<tr><td>${u.day}</td><td>${e(u.model)}</td><td>${u.calls} вызовов</td><td>${u.failures} ошибок</td></tr>`).join("")}</table>
</body></html>`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return path;
}
