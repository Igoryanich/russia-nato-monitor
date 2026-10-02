import { existsSync } from "node:fs";
import { z } from "zod";

// All runtime settings come from the environment (.env locally, secrets/vars in Actions).
if (existsSync(".env")) process.loadEnvFile(".env");

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : /^(1|true|yes)$/i.test(v.trim())));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());
const str = (def = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));

const schema = z.object({
  DATABASE_PATH: str("data/monitor.db"),
  SOURCES_FILE: str("config/sources.yaml"),
  GEMINI_API_KEY: str(),
  // Comma-separated: the first model with remaining quota wins.
  LLM_MODELS: str("gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemma-4-31b-it"),
  LLM_EDITOR_MODELS: str("gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest,gemma-4-31b-it"),
  EMBED_MODEL: str("gemini-embedding-001"),
  LLM_MIN_INTERVAL_MS: int(4500),
  LLM_MAX_CALLS_PER_RUN: int(60),
  LLM_MAX_CALLS_PER_DAY: int(600),
  TRIAGE_BATCH: int(25),
  MAX_ARTICLE_AGE_HOURS: int(72),
  EVENT_WINDOW_HOURS: int(96),
  MAX_ANALYZE_PER_RUN: int(15),
  PUBLISH_THRESHOLD: int(60),
  BREAKING_THRESHOLD: int(90),
  MAX_POSTS_PER_RUN: int(6),
  // auto: publish above threshold; review: everything goes to the admin chat first.
  PUBLISH_MODE: z.enum(["auto", "review"]).optional().default("review"),
  DRY_RUN: bool.transform((v) => v ?? true),
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_CHANNEL_ID: str(),
  TELEGRAM_ADMIN_CHAT_ID: str(),
  DIGEST_HOUR_LOCAL: int(20),
  TIMEZONE: str("Europe/Helsinki"),
  GDELT_ENABLED: bool.transform((v) => v ?? true),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
