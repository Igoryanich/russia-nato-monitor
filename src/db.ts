import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// Schema migrations: append only. PRAGMA user_version tracks the applied count.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    tier TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'neutral',
    country TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT '',
    reliability REAL NOT NULL DEFAULT 0.6,
    focused INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',      -- active | testing | dead | disabled
    origin TEXT NOT NULL DEFAULT 'seed',        -- seed | discovered | admin
    created_at TEXT NOT NULL,
    last_fetch_at TEXT, last_success_at TEXT, last_item_at TEXT, last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    relevant_items INTEGER NOT NULL DEFAULT 0,
    first_reports INTEGER NOT NULL DEFAULT 0,    -- first to report an event later confirmed
    confirmed_reports INTEGER NOT NULL DEFAULT 0,
    false_reports INTEGER NOT NULL DEFAULT 0,
    original_reports INTEGER NOT NULL DEFAULT 0  -- original reporting (not a re-print)
  );
  CREATE TABLE articles (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    lang TEXT,
    published_at TEXT,           -- publication date reported by the source
    collected_at TEXT NOT NULL,  -- discovery date
    links TEXT NOT NULL DEFAULT '[]',
    prefilter INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,        -- new | filtered | old | duplicate | irrelevant | relevant | clustered
    triage TEXT,                 -- JSON from the triage model
    relevance REAL,
    embedding TEXT,
    event_id INTEGER REFERENCES events(id)
  );
  CREATE INDEX articles_status ON articles(status);
  CREATE INDEX articles_title_key ON articles(title_key);
  CREATE INDEX articles_event ON articles(event_id);
  CREATE INDEX articles_collected ON articles(collected_at);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    event_date TEXT,
    title TEXT NOT NULL,          -- working English title
    event_key TEXT NOT NULL DEFAULT '',
    category TEXT,
    signal TEXT,                  -- escalation | counter | neutral
    region TEXT,
    embedding TEXT,
    article_count INTEGER NOT NULL DEFAULT 0,
    independent_count INTEGER NOT NULL DEFAULT 0,
    origins TEXT NOT NULL DEFAULT '[]',
    best_tier TEXT,
    sides TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'new',  -- new | analyzed | queued | review | published | rejected | background
    needs_analysis INTEGER NOT NULL DEFAULT 1,
    analysis TEXT,
    analyzed_article_count INTEGER NOT NULL DEFAULT 0,
    importance INTEGER,
    importance_factors TEXT,
    novelty TEXT,
    escalation_weight REAL,
    published_at TEXT,
    published_version INTEGER NOT NULL DEFAULT 0,
    review_note TEXT
  );
  CREATE INDEX events_updated ON events(updated_at);
  CREATE TABLE publications (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    channel TEXT NOT NULL,
    event_id INTEGER REFERENCES events(id),
    kind TEXT NOT NULL,           -- post | update | breaking | digest | admin
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- review | pending | sending | sent | failed | uncertain | cancelled
    message_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    error TEXT,
    UNIQUE(key, channel)
  );
  CREATE TABLE source_candidates (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    names TEXT NOT NULL DEFAULT '[]',
    sample_urls TEXT NOT NULL DEFAULT '[]',
    mentions INTEGER NOT NULL DEFAULT 0,
    original_mentions INTEGER NOT NULL DEFAULT 0, -- named as the original source of an event
    event_ids TEXT NOT NULL DEFAULT '[]',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    feed_url TEXT,
    probed_at TEXT,
    status TEXT NOT NULL DEFAULT 'new', -- new | no_feed | promoted | rejected
    note TEXT
  );
  CREATE TABLE index_history (
    day TEXT PRIMARY KEY,
    value INTEGER NOT NULL,
    drivers TEXT NOT NULL,
    counters TEXT NOT NULL,
    computed_at TEXT NOT NULL
  );
  CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, stats TEXT);
  CREATE TABLE llm_usage (
    day TEXT NOT NULL, model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(day, model)
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 2: per-publication Telegram extras (reply_to, inline keyboard) and editorial priority.
  `ALTER TABLE publications ADD COLUMN extra TEXT;
   ALTER TABLE publications ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;`,
  // 3: when the current analysis was produced — an update may only follow a newer analysis.
  `ALTER TABLE events ADD COLUMN analyzed_at TEXT;`,
];

export type Row = Record<string, SQLInputValue>;

export class Db {
  raw: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const v = (this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.raw.exec("BEGIN");
      this.raw.exec(MIGRATIONS[i]);
      this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      this.raw.exec("COMMIT");
    }
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  kvGet(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
  }
  kvSet(key: string, value: string) {
    this.run("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  close() {
    // Fold the WAL back so the single .db file is complete before it is committed to git.
    this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.raw.close();
  }
}

export const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
