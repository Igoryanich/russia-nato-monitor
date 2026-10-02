import * as cheerio from "cheerio";
import { fetchText } from "../http.ts";
import { parseDate } from "../util.ts";
import type { Collector, RawItem } from "./types.ts";

/** Public channels via the web preview https://t.me/s/<channel> — no API key, read-only. */
export function parseTelegramPreview(html: string, channel: string): RawItem[] {
  const $ = cheerio.load(html);
  const items: RawItem[] = [];
  $(".tgme_widget_message").each((_, el) => {
    const post = $(el).attr("data-post");
    if (!post) return;
    const textEl = $(el).find(".tgme_widget_message_text").first();
    // Keep line breaks: they separate headline from body in most channels.
    textEl.find("br").replaceWith("\n");
    const text = textEl.text().replace(/[ \t]+/g, " ").trim();
    if (text.length < 40) return; // photo-only or tiny posts carry no reportable content
    const time = $(el).find("time[datetime]").first().attr("datetime");
    const links: string[] = [];
    textEl.find("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (href && /^https?:/.test(href)) links.push(href);
    });
    const firstLine = text.split("\n").find((l) => l.trim().length > 15) ?? text;
    items.push({
      url: `https://t.me/${post}`,
      title: firstLine.slice(0, 200).trim(),
      body: text.slice(0, 4000),
      publishedAt: parseDate(time),
      author: channel,
      links: links.slice(0, 20),
    });
  });
  return items.reverse(); // newest first, like feeds
}

export const telegramCollector: Collector = {
  async collect(source) {
    const channel = source.url.replace(/^https?:\/\/t\.me\/(s\/)?/, "").replace(/\/.*$/, "");
    const { text } = await fetchText(`https://t.me/s/${channel}`);
    return parseTelegramPreview(text, channel);
  },
};
