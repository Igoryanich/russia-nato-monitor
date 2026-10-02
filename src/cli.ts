import { handleCommand } from "./admin/bot.ts";
import { config } from "./config.ts";
import { runCycle } from "./cycle.ts";
import { Db } from "./db.ts";
import { Llm } from "./llm.ts";
import { log } from "./log.ts";
import { analyzePending } from "./pipeline/analyze.ts";
import { clusterRelevant } from "./pipeline/cluster.ts";
import { collectAll } from "./pipeline/collect.ts";
import { buildDigest } from "./pipeline/digest.ts";
import { harvestCandidates, probeCandidates } from "./pipeline/discovery.ts";
import { queuePublications } from "./pipeline/editorial.ts";
import { updateIndex } from "./pipeline/escalation.ts";
import { writeReport } from "./report.ts";
import { loadSeeds, syncSeeds } from "./sources.ts";

const HELP = `Usage: node src/cli.ts <command>
  cycle                 full monitoring cycle (what the scheduler runs)
  quick                 admin-bot commands + deliver approved posts (cheap, between cycles)
  collect [keys...]     fetch sources (optionally only the given source keys)
  triage | cluster | analyze | editorial   run one pipeline stage
  digest                build today's digest and print it (does not queue)
  index                 recompute the escalation signal index
  posts [n]             print the latest n generated posts (queued / review)
  discover              harvest + probe source candidates
  report [file]         write the HTML editorial report (default out/report.html)
  admin "/command"      run an admin-bot command locally, e.g. admin "/status"`;

const [cmd = "help", ...args] = process.argv.slice(2);

const db = new Db(config.DATABASE_PATH);
syncSeeds(db, loadSeeds(config.SOURCES_FILE));
const llm = new Llm(db, config);

try {
  switch (cmd) {
    case "cycle":
      console.log(JSON.stringify(await runCycle(db, config), null, 1));
      break;
    case "quick": {
      // Between full cycles: answer the editor and deliver approved posts. No collection, no AI.
      const { pollAdmin } = await import("./admin/bot.ts");
      const { Telegram } = await import("./telegram.ts");
      const { drain } = await import("./pipeline/publish.ts");
      if (!config.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
      const tg = new Telegram(config.TELEGRAM_BOT_TOKEN);
      console.log({ admin: await pollAdmin(db, config, tg), editorial: queuePublications(db, config), publish: await drain(db, config, tg) });
      break;
    }
    case "collect":
      console.log(await collectAll(db, config, args));
      break;
    case "triage":
      console.log(await (await import("./pipeline/triage.ts")).triagePending(db, llm, config));
      break;
    case "cluster":
      console.log(await clusterRelevant(db, llm, config));
      break;
    case "analyze":
      console.log(await analyzePending(db, llm, config));
      break;
    case "editorial":
      console.log(queuePublications(db, config));
      break;
    case "digest":
      console.log(await buildDigest(db, llm, config));
      break;
    case "index":
      console.log(updateIndex(db, config));
      break;
    case "posts": {
      const rows = db.all<{ id: number; status: string; kind: string; text: string }>(
        "SELECT id, status, kind, text FROM publications WHERE kind != 'admin' ORDER BY id DESC LIMIT ?",
        Number(args[0] ?? 10),
      );
      for (const r of rows.reverse()) console.log(`\n──── #${r.id} [${r.kind} · ${r.status}] ────\n${r.text}`);
      break;
    }
    case "discover":
      console.log({ harvested: harvestCandidates(db), ...(await probeCandidates(db, Number(args[0] ?? 5))) });
      break;
    case "report":
      console.log(writeReport(db, config, args[0] ?? "out/report.html"));
      break;
    case "admin":
      console.log((await handleCommand(db, config, args.join(" "))).replace(/<[^>]+>/g, ""));
      break;
    default:
      console.log(HELP);
  }
} catch (e) {
  log.error("command failed", { cmd, err: e instanceof Error ? e.stack : String(e) });
  process.exitCode = 1;
} finally {
  db.close();
}
