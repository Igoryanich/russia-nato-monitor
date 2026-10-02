import assert from "node:assert/strict";
import { test } from "node:test";
import { approve, handleCommand, reject } from "../src/admin/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { DomainResolver } from "../src/domains.ts";
import type { Analysis } from "../src/pipeline/analyze.ts";
import { checkText, renderPost, visibleLength } from "../src/pipeline/compose.ts";
import { renderDigest } from "../src/pipeline/digest.ts";
import { editorialChecks, queuePublications } from "../src/pipeline/editorial.ts";
import { computeIndex } from "../src/pipeline/escalation.ts";
import { drain } from "../src/pipeline/publish.ts";
import { computeImportance, scoreEvent } from "../src/pipeline/score.ts";
import { loadSeeds, syncSeeds } from "../src/sources.ts";
import { Telegram, TelegramAmbiguous, TelegramRejected } from "../src/telegram.ts";
import { nowIso } from "../src/util.ts";

const cfg = loadConfig({ DRY_RUN: "false", PUBLISH_MODE: "auto", TELEGRAM_CHANNEL_ID: "@test", PUBLISH_THRESHOLD: "60" } as NodeJS.ProcessEnv);

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    relevant: true,
    headline_ru: "Минобороны Польши: российские дроны нарушили воздушное пространство",
    what_ru: "Минобороны Польши заявило, что ночью несколько дронов пересекли границу.",
    why_ru: "Это инцидент на восточном фланге НАТО.",
    confirmation_ru: "Подтверждено Оперативным командованием Польши; Москва не комментировала.",
    context_ru: "Подобные инциденты происходили и ранее.",
    counter_evidence_ru: null,
    watch_ru: null,
    statements: [{ text_ru: "Дроны пересекли границу", type: "OFFICIAL_CLAIM", attributed_to: "Минобороны Польши" }],
    category: "drone_incident",
    signal: "escalation",
    region: "Poland",
    event_date: new Date().toISOString().slice(0, 10),
    novelty: "NEW_EVENT",
    novelty_reason: "",
    duplicate_of: null,
    confidence: 0.9,
    factors: { military_significance: 0.8, geographic_significance: 0.9, direct_relevance: 0.9, official_involvement: 1, baseline_change: 0.6 },
    headline_risk: false,
    primary_url: "https://www.gov.pl/web/obrona-narodowa/x",
    source_urls: ["https://www.gov.pl/web/obrona-narodowa/x", "https://reuters.com/world/x"],
    hashtags: ["Польша", "дроны"],
    ...over,
  };
}

function seededDb(): Db {
  const db = new Db(":memory:");
  syncSeeds(db, loadSeeds("config/sources.yaml"));
  return db;
}

function insertEvent(db: Db, a: Analysis, over: Record<string, unknown> = {}): number {
  const now = nowIso();
  const id = Number(
    db.run(
      `INSERT INTO events(created_at, updated_at, title, analysis, needs_analysis, status, independent_count, best_tier, novelty, category, signal)
       VALUES(?,?,?,?,0,'analyzed',?,?,?,?,?)`,
      now, now, "t", JSON.stringify(a), (over.independent_count as number) ?? 3, (over.best_tier as string) ?? "A", a.novelty, a.category, a.signal,
    ).lastInsertRowid,
  );
  scoreEvent(db, id);
  return id;
}

test("importance: explainable parts, caps for duplicates and social-only sourcing", () => {
  const a = analysis();
  const strong = computeImportance(a, { best_tier: "A", independent_count: 4, sides: [] });
  assert.ok(strong.total >= 75, `expected high importance, got ${strong.total}`);
  assert.ok(Object.keys(strong.parts).length >= 6);
  assert.ok(computeImportance(analysis({ novelty: "DUPLICATE" }), { best_tier: "A", independent_count: 4, sides: [] }).total <= 10);
  const social = computeImportance(a, { best_tier: "G", independent_count: 1, sides: [] });
  assert.ok(social.total <= 45 && social.caps.length > 0);
});

test("text checks catch generated links, coordinates and claims labelled as facts", () => {
  assert.deepEqual(checkText(analysis()), []);
  const codes = checkText(
    analysis({
      what_ru: "Колонна замечена в точке 54.7104, 20.4522, подробнее на https://example.com",
      statements: [{ text_ru: "НАТО готовит нападение", type: "FACT", attributed_to: "МИД России" }],
    }),
  ).map((i) => i.code);
  assert.ok(codes.includes("generated_link"));
  assert.ok(codes.includes("coordinates"));
  assert.ok(codes.includes("claim_as_fact"));
});

test("rendered post: HTML-escaped, attributed sources, within Telegram limits", () => {
  const db = seededDb();
  const post = renderPost({ a: analysis({ headline_ru: "Минобороны <script>: дроны" }), importance: 82, breaking: false, isUpdate: false, resolver: new DomainResolver(db) });
  assert.ok(post.startsWith("🔴 <b>Минобороны &lt;script&gt;: дроны</b>"));
  assert.ok(post.includes('<a href="https://reuters.com/world/x">Reuters</a>'));
  assert.ok(visibleLength(post) <= 4096);
  // Context and counter-signals never both appear: max four paragraphs before sources.
  const both = renderPost({ a: analysis({ counter_evidence_ru: "Москва отрицает." }), importance: 70, breaking: false, isUpdate: false, resolver: new DomainResolver(db) });
  assert.ok(both.includes("Контрсигналы") && !both.includes("Контекст"));
});

test("editorial gate: fresh significant event is queued, stale/old/duplicate ones are not", () => {
  const db = seededDb();
  const good = insertEvent(db, analysis());
  const old = insertEvent(db, analysis({ event_date: "2026-01-01", headline_ru: "Старое событие о дронах над Польшей" }));
  const dup = insertEvent(db, analysis({ novelty: "OLD_RESURFACED", headline_ru: "Повторно разошедшееся видео колонны" }));
  const r = queuePublications(db, cfg);
  assert.equal(r.queued, 1);
  assert.equal(db.get<{ status: string }>("SELECT status FROM events WHERE id = ?", good)!.status, "queued");
  for (const id of [old, dup]) assert.equal(db.get<{ status: string }>("SELECT status FROM events WHERE id = ?", id)!.status, "background");
  // Re-running is idempotent.
  assert.equal(queuePublications(db, cfg).queued, 0);
});

test("editorial gate: risky item is held back in auto mode, sent to review in review mode", () => {
  const db = seededDb();
  const id = insertEvent(db, analysis({ headline_risk: true }));
  const auto = queuePublications(db, cfg);
  assert.equal(auto.queued, 0);
  assert.equal(auto.review, 0);
  assert.equal(db.get<{ status: string }>("SELECT status FROM events WHERE id = ?", id)!.status, "background");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM publications")!.n, 0);

  const db2 = seededDb();
  insertEvent(db2, analysis({ headline_risk: true }));
  const r = queuePublications(db2, { ...cfg, PUBLISH_MODE: "review" });
  assert.equal(r.review, 1);
  assert.equal(r.queued, 0);
  const checks = editorialChecks(
    { id: 1, analysis: "", importance: 70, importance_factors: "", independent_count: 1, best_tier: "G", published_version: 0, event_date: null, status: "analyzed" },
    analysis(),
    cfg,
  );
  assert.ok(checks.some((c) => !c.ok && !c.hard));
});

test("published event: only a SIGNIFICANT_UPDATE produces a follow-up post, as a reply", () => {
  const db = seededDb();
  const id = insertEvent(db, analysis({ novelty: "MINOR_UPDATE" }));
  db.run("UPDATE events SET status = 'published', published_version = 1 WHERE id = ?", id);
  db.run("INSERT INTO publications(key, channel, event_id, kind, text, status, message_id, created_at) VALUES('event:'||?||':v1','@test',?,'post','x','sent',555,?)", id, id, nowIso());
  assert.equal(queuePublications(db, cfg).queued, 0);
  db.run("UPDATE events SET analysis = ? WHERE id = ?", JSON.stringify(analysis({ novelty: "SIGNIFICANT_UPDATE" })), id);
  scoreEvent(db, id);
  assert.equal(queuePublications(db, cfg).queued, 1);
  const p = db.get<{ kind: string; extra: string; text: string }>("SELECT kind, extra, text FROM publications WHERE key = ?", `event:${id}:v2`)!;
  assert.equal(p.kind, "update");
  assert.equal(JSON.parse(p.extra).reply_parameters.message_id, 555);
  assert.ok(p.text.includes("Обновление:"));
});

class FakeTelegram extends Telegram {
  sent: string[] = [];
  behaviour: "ok" | "ambiguous" | "429" = "ok";
  constructor() {
    super("test");
  }
  override async send(_chat: string, html: string): Promise<number> {
    if (this.behaviour === "ambiguous") throw new TelegramAmbiguous("server 502");
    if (this.behaviour === "429") throw new TelegramRejected(429, "Too Many Requests", 30);
    this.sent.push(html);
    return 1000 + this.sent.length;
  }
}

test("delivery: sent once, ambiguous sends are never retried blindly, 429 is deferred", async () => {
  const db = seededDb();
  const id = insertEvent(db, analysis());
  queuePublications(db, cfg);
  const tg = new FakeTelegram();
  tg.behaviour = "ambiguous";
  assert.deepEqual(await drain(db, cfg, tg), { sent: 0, failed: 1 });
  assert.equal(db.get<{ status: string }>("SELECT status FROM publications WHERE event_id = ?", id)!.status, "uncertain");
  assert.equal((await drain(db, cfg, tg)).sent, 0); // uncertain stays put

  const id2 = insertEvent(db, analysis({ headline_ru: "Минобороны Литвы: инцидент на границе с Беларусью" }));
  queuePublications(db, cfg);
  tg.behaviour = "429";
  await drain(db, cfg, tg);
  const p = db.get<{ status: string; retry_at: string }>("SELECT status, retry_at FROM publications WHERE event_id = ?", id2)!;
  assert.equal(p.status, "pending");
  assert.ok(p.retry_at > nowIso());

  db.run("UPDATE publications SET retry_at = NULL WHERE event_id = ?", id2);
  tg.behaviour = "ok";
  assert.equal((await drain(db, cfg, tg)).sent, 1);
  assert.equal(db.get<{ status: string; published_version: number }>("SELECT status, published_version FROM events WHERE id = ?", id2)!.published_version, 1);
  assert.equal((await drain(db, cfg, tg)).sent, 0); // never twice
});

test("dry run queues but never sends", async () => {
  const db = seededDb();
  insertEvent(db, analysis());
  queuePublications(db, cfg);
  const tg = new FakeTelegram();
  assert.deepEqual(await drain(db, { ...cfg, DRY_RUN: true }, tg), { sent: 0, failed: 0 });
  assert.equal(tg.sent.length, 0);
});

test("admin approve/reject and commands", async () => {
  const db = seededDb();
  insertEvent(db, analysis({ headline_risk: true }));
  queuePublications(db, { ...cfg, PUBLISH_MODE: "review" });
  const pub = db.get<{ id: number }>("SELECT id FROM publications WHERE status = 'review'")!;
  assert.match(approve(db, pub.id), /одобрено/);
  assert.equal(db.get<{ status: string }>("SELECT status FROM publications WHERE id = ?", pub.id)!.status, "pending");
  assert.match(reject(db, pub.id), /отклонено/);
  assert.match(await handleCommand(db, cfg, "/status"), /Состояние/);
  assert.match(await handleCommand(db, cfg, "/mode auto"), /auto/);
  assert.match(await handleCommand(db, cfg, "/why_1"), /#1/);
});

test("escalation index: counter-signals offset escalation, value bounded, not a probability", () => {
  const db = seededDb();
  insertEvent(db, analysis());
  const up = computeIndex(db);
  assert.ok(up.value > 0 && up.value < 100);
  assert.equal(up.drivers.length, 1);
  insertEvent(db, analysis({ signal: "counter", category: "diplomatic_deescalation", headline_ru: "Учения завершены, войска вернулись в пункты дислокации" }));
  const down = computeIndex(db);
  assert.ok(down.value < up.value);
  assert.equal(down.counters.length, 1);
});

test("digest renders sections and the index disclaimer", () => {
  const text = renderDigest({
    day: "2026-10-02",
    items: [
      { id: 1, headline: "Дроны над Польшей", url: "https://x.pl/1", signal: "escalation", category: "drone_incident", importance: 80, region: "Poland", confirmation: "" },
      { id: 2, headline: "Учения завершены", url: "https://x.pl/2", signal: "counter", category: "exercise", importance: 50, region: "Belarus", confirmation: "" },
    ],
    index: { today: 47, yesterday: 43, weekAgo: 36 },
    summary: "Вывод.",
    watch: ["Калининград"],
  });
  assert.match(text, /Сводка за 2 октября/);
  assert.match(text, /<b>47<\/b>\/100 \(\+4 за сутки\)/);
  assert.match(text, /🟢 <b>Контрсигналы<\/b>/);
  assert.match(text, /не вероятность войны/);
});

test("switching review → auto releases clean waiting posts and drops their admin previews", () => {
  const db = seededDb();
  const id = insertEvent(db, analysis());
  queuePublications(db, { ...cfg, PUBLISH_MODE: "review", TELEGRAM_ADMIN_CHAT_ID: "42" });
  const pub = db.get<{ id: number; status: string }>("SELECT id, status FROM publications WHERE kind = 'post'")!;
  assert.equal(pub.status, "review");
  db.run("UPDATE events SET status = 'review' WHERE id = ?", id);
  queuePublications(db, cfg); // auto
  assert.equal(db.get<{ status: string }>("SELECT status FROM publications WHERE id = ?", pub.id)!.status, "pending");
  assert.equal(db.get<{ status: string }>("SELECT status FROM publications WHERE key = ?", `admin:${pub.id}`)!.status, "cancelled");
  assert.equal(db.get<{ status: string }>("SELECT status FROM events WHERE id = ?", id)!.status, "queued");
});
