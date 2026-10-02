export type SourceKind = "rss" | "telegram" | "web" | "gdelt" | "bluesky";

/** A source row as the collectors see it (DB `sources` table). */
export interface SourceRow {
  id: number;
  key: string;
  name: string;
  kind: SourceKind;
  url: string;
  tier: string;
  side: string;
  country: string;
  lang: string;
  reliability: number;
  focused: number; // 1 = topic-specific source, skip keyword pre-filter
  config: string; // JSON
  last_fetch_at?: string | null;
}

export interface RawItem {
  url: string;
  title: string;
  body: string;
  publishedAt: string | null;
  /** For aggregators (GDELT) the real publisher domain differs from the source. */
  domain?: string;
  lang?: string;
  author?: string;
  /** Outbound links found in the item — fuel for source discovery. */
  links: string[];
}

export interface Collector {
  collect(source: SourceRow): Promise<RawItem[]>;
}
