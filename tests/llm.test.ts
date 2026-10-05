import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { Llm } from "../src/llm.ts";

const ok = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 500 } }), { status: 200 });

test("editor tier uses the paid key first and stops at the daily EUR cap", async () => {
  const cfg = loadConfig({ GEMINI_API_KEY: "free", GEMINI_PAID_API_KEY: "paid", PAID_DAILY_BUDGET_EUR: "0.05", LLM_MIN_INTERVAL_MS: "0", LLM_EDITOR_MODELS: "free-editor" } as NodeJS.ProcessEnv);
  const db = new Db(":memory:");
  const keys: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    keys.push(`${(init.headers as Record<string, string>)["x-goog-api-key"]}:${String(url).split("/models/")[1]?.split(":")[0]}`);
    return ok('{"a":"x"}');
  }) as typeof fetch;
  try {
    const llm = new Llm(db, cfg);
    const schema = z.object({ a: z.string() });
    await llm.json({ system: "s", user: "u", schema, tier: "editor", maxTokens: 1000 });
    assert.deepEqual(keys, ["paid:gemini-3.8-flash"]);
    // simulate a day already close to the cap → the paid model is skipped, free chain answers
    db.run("UPDATE llm_usage SET tokens_in = 20000, tokens_out = 10000 WHERE model = 'paid:gemini-3.8-flash'");
    assert.ok(llm.paidSpendToday() > 0.04);
    await llm.json({ system: "s", user: "u", schema, tier: "editor", maxTokens: 1000 });
    assert.equal(keys.at(-1), "free:free-editor");
    // the cheap tier never touches the paid key
    await llm.json({ system: "s", user: "u", schema, tier: "cheap" });
    assert.ok(!keys.at(-1)!.startsWith("paid:"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
