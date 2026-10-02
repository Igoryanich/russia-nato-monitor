import { z } from "zod";
import { httpsGetText } from "../http.ts";
import { domainOf, sleep } from "../util.ts";
import type { Collector, RawItem } from "./types.ts";

// GDELT DOC 2.0 API: free, keyless, multilingual discovery. ~1 request / 5 s etiquette.
const schema = z.object({
  articles: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().default(""),
        seendate: z.string().optional(),
        domain: z.string().optional(),
        language: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});

let lastCall = 0;

function seenDate(s?: string): string | null {
  const m = s && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

export const gdeltCollector: Collector = {
  async collect(source) {
    const cfg = JSON.parse(source.config || "{}") as { query?: string; timespan?: string; max?: number };
    if (!cfg.query) throw new Error("gdelt source needs config.query");
    const params = new URLSearchParams({
      query: cfg.query,
      mode: "ArtList",
      format: "json",
      sort: "DateDesc",
      maxrecords: String(cfg.max ?? 75),
      timespan: cfg.timespan ?? "6h",
    });
    let text = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = (attempt ? 15_000 : 7_000) - (Date.now() - lastCall);
      if (wait > 0) await sleep(wait);
      const res = await httpsGetText(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
      lastCall = Date.now();
      text = res.text;
      if (res.status !== 429) break;
    }
    if (!text.trim().startsWith("{")) throw new Error(`gdelt: ${text.slice(0, 120)}`);
    const data = schema.parse(JSON.parse(text));
    return data.articles.map(
      (a): RawItem => ({
        url: a.url,
        title: a.title.trim(),
        body: "",
        publishedAt: seenDate(a.seendate),
        domain: a.domain?.toLowerCase().replace(/^www\./, "") ?? domainOf(a.url),
        lang: a.language,
        links: [],
      }),
    );
  },
};
