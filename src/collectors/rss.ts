import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { fetchText } from "../http.ts";
import { htmlToText, parseDate } from "../util.ts";
import type { Collector, RawItem, SourceRow } from "./types.ts";

const parser = new Parser({ customFields: { item: [["content:encoded", "contentEncoded"], ["dc:date", "dcDate"]] } });

export function linksIn(html: string, base?: string): string[] {
  if (!html || !html.includes("href")) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const u = new URL(href, base);
      if (/^https?:$/.test(u.protocol)) out.add(u.toString());
    } catch {
      /* ignore */
    }
  });
  return [...out].slice(0, 40);
}

export async function parseFeed(xml: string, limit = 60): Promise<RawItem[]> {
  const feed = await parser.parseString(xml);
  const items: RawItem[] = [];
  for (const it of feed.items.slice(0, limit)) {
    const link = it.link ?? (typeof it.guid === "string" && /^https?:/.test(it.guid) ? it.guid : undefined);
    if (!link || !it.title) continue;
    const any = it as unknown as Record<string, unknown>;
    const html = String(any.contentEncoded ?? it.content ?? it.summary ?? "");
    items.push({
      url: link.trim(),
      title: htmlToText(it.title).slice(0, 400),
      body: htmlToText(html || it.contentSnippet || "").slice(0, 6000),
      publishedAt: parseDate(it.isoDate ?? it.pubDate ?? any.dcDate),
      author: it.creator ?? (any.author as string | undefined),
      links: linksIn(html, link),
    });
  }
  return items;
}

export const rssCollector: Collector = {
  async collect(source: SourceRow) {
    const { text } = await fetchText(source.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    return parseFeed(text);
  },
};

/** Look for <link rel="alternate" type="application/rss+xml"> and common feed paths. */
export async function discoverFeed(pageUrl: string): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const { text, url } = await fetchText(pageUrl, { timeoutMs: 15_000 });
    if (/<(rss|feed)[\s>]/i.test(text.slice(0, 2000))) return url;
    const $ = cheerio.load(text);
    $('link[rel="alternate"]').each((_, el) => {
      const type = $(el).attr("type") ?? "";
      const href = $(el).attr("href");
      if (href && /rss|atom|xml/i.test(type)) candidates.push(new URL(href, url).toString());
    });
  } catch {
    /* fall through to guesses */
  }
  const origin = new URL(pageUrl).origin;
  candidates.push(`${origin}/feed`, `${origin}/rss`, `${origin}/rss.xml`, `${origin}/feed.xml`, `${origin}/en/feed`);
  for (const c of [...new Set(candidates)].slice(0, 7)) {
    try {
      const { text } = await fetchText(c, { timeoutMs: 12_000 });
      if (/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 3000))) {
        const items = await parseFeed(text, 5);
        if (items.length) return c;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}
