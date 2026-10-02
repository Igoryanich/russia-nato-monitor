import type { Db } from "./db.ts";
import { sourceByDomain } from "./sources.ts";
import { rootDomain } from "./util.ts";

export interface DomainInfo {
  tier: string;
  side: string;
  reliability: number;
  name: string;
  known: boolean;
}

// Publishers that matter for attribution even though we have no feed for them
// (they arrive via GDELT or links). Tier semantics as in config/sources.yaml.
const STATIC: Record<string, [tier: string, side: string, rel: number, name: string]> = {
  "reuters.com": ["B", "neutral", 0.92, "Reuters"],
  "bbc.co.uk": ["C", "neutral", 0.85, "BBC"],
  "bbc.com": ["C", "neutral", 0.85, "BBC"],
  "dw.com": ["C", "neutral", 0.82, "DW"],
  "theguardian.com": ["C", "neutral", 0.82, "Guardian"],
  "telegraph.co.uk": ["C", "neutral", 0.78, "The Telegraph"],
  "politico.eu": ["C", "neutral", 0.8, "Politico Europe"],
  "yle.fi": ["D", "neutral", 0.82, "Yle"],
  "err.ee": ["D", "neutral", 0.8, "ERR"],
  "lrt.lt": ["D", "neutral", 0.8, "LRT"],
  "lsm.lv": ["D", "neutral", 0.8, "LSM"],
  "apnews.com": ["B", "neutral", 0.92, "AP"],
  "afp.com": ["B", "neutral", 0.9, "AFP"],
  "france24.com": ["C", "neutral", 0.8, "France24"],
  "bloomberg.com": ["C", "neutral", 0.85, "Bloomberg"],
  "ft.com": ["C", "neutral", 0.85, "Financial Times"],
  "nytimes.com": ["C", "neutral", 0.85, "New York Times"],
  "washingtonpost.com": ["C", "neutral", 0.85, "Washington Post"],
  "wsj.com": ["C", "neutral", 0.85, "Wall Street Journal"],
  "cnn.com": ["C", "neutral", 0.78, "CNN"],
  "economist.com": ["C", "neutral", 0.85, "The Economist"],
  "nato.int": ["A", "nato", 0.9, "NATO"],
  "kremlin.ru": ["A", "ru", 0.9, "Кремль"],
  "mid.ru": ["A", "ru", 0.9, "МИД России"],
  "mil.ru": ["A", "ru", 0.9, "Минобороны России"],
  "scrf.gov.ru": ["A", "ru", 0.9, "Совбез России"],
  "duma.gov.ru": ["A", "ru", 0.85, "Госдума"],
  "council.gov.ru": ["A", "ru", 0.85, "Совет Федерации"],
  "president.gov.by": ["A", "by", 0.9, "Президент Беларуси"],
  "mil.by": ["A", "by", 0.9, "Минобороны Беларуси"],
  "tass.com": ["S", "ru", 0.5, "ТАСС"],
  "tass.ru": ["S", "ru", 0.5, "ТАСС"],
  "ria.ru": ["S", "ru", 0.45, "РИА Новости"],
  "rt.com": ["S", "ru", 0.3, "RT"],
  "iz.ru": ["S", "ru", 0.4, "Известия"],
  "rg.ru": ["S", "ru", 0.45, "Российская газета"],
  "belta.by": ["S", "by", 0.45, "БелТА"],
  "sputnik.by": ["S", "by", 0.3, "Sputnik"],
  "understandingwar.org": ["E", "neutral", 0.75, "ISW"],
  "t.me": ["G", "neutral", 0.35, "Telegram"],
  "x.com": ["G", "neutral", 0.3, "X"],
  "twitter.com": ["G", "neutral", 0.3, "X"],
  "bsky.app": ["G", "neutral", 0.35, "Bluesky"],
};

const OFFICIAL = /(^|\.)(gov(\.[a-z]{2})?|mil(\.[a-z]{2})?|gouv\.fr|gc\.ca|europa\.eu|valtioneuvosto\.fi|defmin\.fi|puolustusvoimat\.fi|raja\.fi|supo\.fi|um\.fi|mil\.ee|kaitseministeerium\.ee|valisluureamet\.ee|kapo\.ee|mod\.gov\.lv|mil\.lv|kam\.lt|vsd\.lt|forsvarsmakten\.se|regeringen\.se|sakerhetspolisen\.se|forsvaret\.no|regjeringen\.no|fe-ddis\.dk|forsvaret\.dk|fmn\.dk|bundeswehr\.de|bmvg\.de|bnd\.bund\.de|nato\.int)$/;

export class DomainResolver {
  private bySource: ReturnType<typeof sourceByDomain>;
  constructor(db: Db) {
    this.bySource = sourceByDomain(db);
  }
  resolve(host: string): DomainInfo {
    const h = host.toLowerCase().replace(/^www\./, "");
    for (const cand of [h, rootDomain(h)]) {
      const s = this.bySource.get(cand);
      if (s) return { tier: s.tier, side: s.side, reliability: s.reliability, name: s.name, known: true };
      const st = STATIC[cand];
      if (st) return { tier: st[0], side: st[1], reliability: st[2], name: st[3], known: true };
    }
    if (OFFICIAL.test(h)) {
      const side = /\.(ru|by)$/.test(h) ? (h.endsWith(".by") ? "by" : "ru") : "nato";
      return { tier: "A", side, reliability: 0.85, name: h, known: false };
    }
    return { tier: "D", side: "neutral", reliability: 0.5, name: h, known: false };
  }
}
