import { blueskyCollector } from "./bluesky.ts";
import { gdeltCollector } from "./gdelt.ts";
import { rssCollector } from "./rss.ts";
import { telegramCollector } from "./telegram.ts";
import type { Collector, SourceKind } from "./types.ts";

export const collectors: Record<Exclude<SourceKind, "web">, Collector> = {
  rss: rssCollector,
  telegram: telegramCollector,
  gdelt: gdeltCollector,
  bluesky: blueskyCollector,
};
