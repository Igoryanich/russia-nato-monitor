import { z } from "zod";
import { fetchText } from "../http.ts";
import { parseDate } from "../util.ts";
import type { Collector, RawItem } from "./types.ts";

// Public AppView: no auth needed for reading an author's feed.
const schema = z.object({
  feed: z.array(
    z.object({
      post: z.object({
        uri: z.string(),
        author: z.object({ handle: z.string() }),
        record: z.object({ text: z.string().default(""), createdAt: z.string().optional() }).passthrough(),
        embed: z.any().optional(),
      }),
      reason: z.any().optional(),
    }),
  ),
});

export const blueskyCollector: Collector = {
  async collect(source) {
    const handle = source.url.replace(/^https?:\/\/bsky\.app\/profile\//, "").replace(/\/.*$/, "");
    const { text } = await fetchText(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=40&filter=posts_no_replies`,
    );
    const data = schema.parse(JSON.parse(text));
    const items: RawItem[] = [];
    for (const { post, reason } of data.feed) {
      if (reason) continue; // reposts are someone else's content
      const body = post.record.text.trim();
      if (body.length < 40) continue;
      const rkey = post.uri.split("/").pop();
      const external = post.embed?.external?.uri as string | undefined;
      items.push({
        url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
        title: body.split("\n")[0].slice(0, 200),
        body,
        publishedAt: parseDate(post.record.createdAt),
        author: post.author.handle,
        links: external ? [external] : [],
      });
    }
    return items;
  },
};
