import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramPreview } from "../src/collectors/telegram.ts";
import { extractArticleMeta } from "../src/collectors/web.ts";
import { decideMerge, jaccard, keyTokens } from "../src/pipeline/cluster.ts";
import { prefilterScore } from "../src/pipeline/prefilter.ts";
import { canonicalUrl, rootDomain } from "../src/util.ts";

test("canonicalUrl strips tracking, www, fragments and trailing slash", () => {
  assert.equal(
    canonicalUrl("http://www.Example.com/news/item/?utm_source=x&b=2&a=1&maca=rus#top"),
    "https://example.com/news/item?a=1&b=2",
  );
  assert.throws(() => canonicalUrl("ftp://example.com/x"));
});

test("rootDomain keeps second-level public suffixes", () => {
  assert.equal(rootDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(rootDomain("rus.err.ee"), "err.ee");
});

test("prefilter: multilingual recall, unrelated text scores low", () => {
  assert.ok(prefilterScore("Russian drones violated Polish airspace near the Belarus border") >= 2);
  assert.ok(prefilterScore("Venäjän sotilaat harjoitus lähellä itärajaa") >= 1);
  assert.ok(prefilterScore("Российские военные провели учения в Калининградской области") >= 2);
  assert.ok(prefilterScore("Rosyjskie drony naruszyły przestrzeń powietrzną Polski") >= 2);
  assert.equal(prefilterScore("Apple released a new iPhone with a better camera"), 0);
  // "senator" contains "nato" but must not match: word-start anchoring.
  assert.equal(prefilterScore("The senator spoke about tax policy"), 0);
});

test("telegram preview parser extracts posts, links and dates", () => {
  const html = `
  <div class="tgme_widget_message" data-post="mod_russia/123">
    <div class="tgme_widget_message_text">Первая строка заголовка поста<br>Подробный текст сообщения о военных учениях в регионе, довольно длинный. <a href="https://example.org/doc">док</a></div>
    <time datetime="2026-10-02T10:00:00+00:00"></time>
  </div>
  <div class="tgme_widget_message" data-post="mod_russia/124"><div class="tgme_widget_message_text">коротко</div></div>`;
  const items = parseTelegramPreview(html, "mod_russia");
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://t.me/mod_russia/123");
  assert.equal(items[0].title, "Первая строка заголовка поста");
  assert.equal(items[0].publishedAt, "2026-10-02T10:00:00.000Z");
  assert.deepEqual(items[0].links, ["https://example.org/doc"]);
});

test("article meta extraction reads og tags and published time", () => {
  const html = `<html><head><meta property="og:title" content="Minister visits border">
    <meta property="article:published_time" content="2026-10-01T08:00:00Z"></head>
    <body><article><p>${"Long paragraph about the visit to the eastern border region. ".repeat(3)}</p>
    <a href="https://nato.int/en/x">NATO</a></article></body></html>`;
  const m = extractArticleMeta(html, "https://defmin.fi/en/-/x");
  assert.equal(m.title, "Minister visits border");
  assert.equal(m.publishedAt, "2026-10-01T08:00:00.000Z");
  assert.deepEqual(m.links, ["https://nato.int/en/x"]);
});

test("event keys: tokens ignore years and stop words", () => {
  const a = keyTokens("russia-drones-violate-poland-airspace-2026-10");
  const b = keyTokens("russian-drones-poland-airspace-violation-2026-10");
  assert.ok(!a.has("2026"));
  assert.ok(jaccard(a, b) > 0.3);
});

test("cluster merge decision is conservative and explainable", () => {
  const unit = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const ev = { id: 7, embedding: unit([1, 0.1, 0]), key: keyTokens("russia-drones-poland-airspace"), category: "drone_incident", region: "Poland" };
  // Near-identical vector merges on similarity alone.
  assert.equal(decideMerge(unit([1, 0.1, 0.001]), { event_key: "x", category: "other", region: "" }, [ev])?.id, 7);
  // Unrelated vector never merges, even with the same category.
  assert.equal(decideMerge(unit([0, 1, 1]), { event_key: "russia-drones-poland-airspace", category: "drone_incident", region: "Poland" }, [ev]), null);
});
