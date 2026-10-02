import * as cheerio from "cheerio";
import { fetchText } from "../http.ts";
import { htmlToText, parseDate } from "../util.ts";
import type { RawItem, SourceRow } from "./types.ts";

// For official sites without RSS: read a news-list page, keep links matching
// config.linkPattern, then open only *unseen* articles (bounded) to get the
// real title, lead and publication date from page metadata.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 RussiaNatoMonitor/0.1";

export function extractArticleMeta(html: string, url: string): Omit<RawItem, "url"> {
  const $ = cheerio.load(html);
  const meta = (sel: string) => $(sel).attr("content")?.trim();
  let published =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="article:published_time"]') ??
    meta('meta[itemprop="datePublished"]') ??
    meta('meta[name="date"]') ??
    meta('meta[name="DC.date.issued"]') ??
    $("time[datetime]").first().attr("datetime");
  if (!published) {
    $('script[type="application/ld+json"]').each((_, el) => {
      const m = /"datePublished"\s*:\s*"([^"]+)"/.exec($(el).text());
      if (m && !published) published = m[1];
    });
  }
  const title = meta('meta[property="og:title"]') ?? $("h1").first().text().trim() ?? $("title").text().trim();
  const desc = meta('meta[property="og:description"]') ?? meta('meta[name="description"]') ?? "";
  $("script,style,nav,header,footer,aside,form").remove();
  const paragraphs = $("article p, main p, .content p, p")
    .map((_, p) => $(p).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((t) => t.length > 60)
    .slice(0, 12)
    .join("\n");
  const links: string[] = [];
  $("article a[href], main a[href]").each((_, a) => {
    try {
      const u = new URL($(a).attr("href")!, url);
      if (/^https?:$/.test(u.protocol) && u.hostname !== new URL(url).hostname) links.push(u.toString());
    } catch {
      /* ignore */
    }
  });
  return {
    title: htmlToText(title).slice(0, 400),
    body: [desc, paragraphs].filter(Boolean).join("\n").slice(0, 6000),
    publishedAt: parseDate(published),
    links: [...new Set(links)].slice(0, 30),
  };
}

export async function collectWeb(
  source: SourceRow,
  isKnown: (url: string) => boolean,
  maxNew = 8,
): Promise<RawItem[]> {
  const cfg = JSON.parse(source.config || "{}") as { linkPattern?: string };
  if (!cfg.linkPattern) throw new Error("web source needs config.linkPattern");
  const pattern = new RegExp(cfg.linkPattern);
  const { text, url: base } = await fetchText(source.url, { headers: { "User-Agent": BROWSER_UA } });
  const $ = cheerio.load(text);
  const links = new Set<string>();
  $("a[href]").each((_, a) => {
    try {
      const u = new URL($(a).attr("href")!, base);
      u.hash = "";
      if (pattern.test(u.pathname)) links.add(u.toString());
    } catch {
      /* ignore */
    }
  });
  const fresh = [...links].filter((l) => !isKnown(l)).slice(0, maxNew);
  const items: RawItem[] = [];
  for (const link of fresh) {
    try {
      const page = await fetchText(link, { headers: { "User-Agent": BROWSER_UA }, timeoutMs: 20_000 });
      const meta = extractArticleMeta(page.text, link);
      if (meta.title) items.push({ url: link, ...meta });
    } catch {
      /* one broken article must not sink the source */
    }
  }
  return items;
}
