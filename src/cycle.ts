import { pollAdmin } from "./admin/bot.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { Llm } from "./llm.ts";
import { errMsg, log } from "./log.ts";
import { analyzePending } from "./pipeline/analyze.ts";
import { clusterRelevant } from "./pipeline/cluster.ts";
import { collectAll } from "./pipeline/collect.ts";
import { maybeDigest } from "./pipeline/digest.ts";
import { harvestCandidates, probeCandidates, reviewTestingSources } from "./pipeline/discovery.ts";
import { queuePublications } from "./pipeline/editorial.ts";
import { updateIndex } from "./pipeline/escalation.ts";
import { creditSources, prune, sourceHealth } from "./pipeline/maintenance.ts";
import { drain } from "./pipeline/publish.ts";
import { triagePending } from "./pipeline/triage.ts";
import { Telegram } from "./telegram.ts";
import { nowIso } from "./util.ts";

/** One monitoring cycle. Each stage is isolated: a failure is recorded and the cycle moves on. */
export async function runCycle(db: Db, cfg: Config): Promise<Record<string, unknown>> {
  const runId = Number(db.run("INSERT INTO runs(started_at) VALUES(?)", nowIso()).lastInsertRowid);
  const stats: Record<string, unknown> = {};
  const llm = new Llm(db, cfg);
  const tg = cfg.TELEGRAM_BOT_TOKEN ? new Telegram(cfg.TELEGRAM_BOT_TOKEN) : null;
  const stage = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = Date.now();
    try {
      stats[name] = await fn();
    } catch (e) {
      stats[name] = { error: errMsg(e) };
      log.error(`stage ${name} failed`, { err: e instanceof Error ? e.stack : String(e) });
    }
    log.info(`stage ${name}`, { ms: Date.now() - t0 });
  };

  if (tg) await stage("admin", () => pollAdmin(db, cfg, tg));
  await stage("collect", async () => {
    const s = await collectAll(db, cfg);
    return { ...s, errors: Object.keys(s.errors) };
  });
  if (llm.enabled) {
    await stage("triage", () => triagePending(db, llm, cfg));
    await stage("cluster", () => clusterRelevant(db, llm, cfg));
    await stage("analyze", () => analyzePending(db, llm, cfg));
  } else stats.llm = "GEMINI_API_KEY not set — AI stages skipped";
  await stage("editorial", () => queuePublications(db, cfg));
  await stage("index", () => updateIndex(db, cfg).value);
  if (llm.enabled) await stage("digest", () => maybeDigest(db, llm, cfg));
  await stage("publish", () => drain(db, cfg, tg));
  await stage("discovery", async () => ({ harvested: harvestCandidates(db), ...(await probeCandidates(db)), ...reviewTestingSources(db) }));
  await stage("health", () => sourceHealth(db));
  await stage("feedback", () => creditSources(db));
  await stage("prune", () => prune(db));
  stats.llm_calls = llm.calls;
  db.run("UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?", nowIso(), JSON.stringify(stats), runId);
  return stats;
}
