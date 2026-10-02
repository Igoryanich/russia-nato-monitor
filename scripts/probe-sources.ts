// One-off: probe candidate seed URLs live, try feed autodiscovery on failures.
// Usage: node scripts/probe-sources.ts > out/probe.json
import { discoverFeed, parseFeed } from "../src/collectors/rss.ts";
import { telegramCollector } from "../src/collectors/telegram.ts";
import { fetchText } from "../src/http.ts";
import type { SourceRow } from "../src/collectors/types.ts";

// [key, kind, url, homepage-for-discovery]
const C: [string, string, string, string?][] = [
  // NATO
  ["nato-news", "rss", "https://www.nato.int/cps/rss/en/natohq/rssFeed.xsl/rssFeed.xml", "https://www.nato.int/"],
  ["shape", "rss", "https://shape.nato.int/rss", "https://shape.nato.int/news-releases"],
  ["nato-aircom", "rss", "https://ac.nato.int/rss", "https://ac.nato.int/"],
  ["nato-marcom", "rss", "https://mc.nato.int/rss", "https://mc.nato.int/"],
  ["nato-jfcbs", "rss", "https://jfcbs.nato.int/rss", "https://jfcbs.nato.int/"],
  ["nato-act", "rss", "https://www.act.nato.int/feed/", "https://www.act.nato.int/"],
  // Finland
  ["fi-puolustusvoimat", "rss", "https://puolustusvoimat.fi/en/news.rss", "https://puolustusvoimat.fi/en/"],
  ["fi-defmin", "rss", "https://www.defmin.fi/en/rss", "https://www.defmin.fi/en"],
  ["fi-raja", "rss", "https://raja.fi/en/rss", "https://raja.fi/en"],
  ["fi-valtioneuvosto", "rss", "https://valtioneuvosto.fi/en/rss", "https://valtioneuvosto.fi/en/frontpage"],
  ["fi-um", "rss", "https://um.fi/rss", "https://um.fi/frontpage"],
  ["fi-supo", "rss", "https://supo.fi/en/rss", "https://supo.fi/en/frontpage"],
  ["yle-news-en", "rss", "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_NEWS"],
  ["yle-uutiset", "rss", "https://feeds.yle.fi/uutiset/v1/majorHeadlines/YLE_UUTISET.rss"],
  ["yle-novosti", "rss", "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_NOVOSTI"],
  ["hs", "rss", "https://www.hs.fi/rss/tuoreimmat.xml"],
  ["iltalehti", "rss", "https://www.iltalehti.fi/rss/uutiset.xml"],
  ["is", "rss", "https://www.is.fi/rss/tuoreimmat.xml"],
  ["mtv-uutiset", "rss", "https://api.mtvuutiset.fi/mtvuutiset/rss"],
  // Estonia
  ["ee-mil", "rss", "https://mil.ee/en/feed/", "https://mil.ee/en/"],
  ["ee-kaitseministeerium", "rss", "https://kaitseministeerium.ee/en/rss.xml", "https://kaitseministeerium.ee/en"],
  ["ee-valisluureamet", "rss", "https://www.valisluureamet.ee/en/rss", "https://www.valisluureamet.ee/en"],
  ["ee-kapo", "rss", "https://kapo.ee/en/feed", "https://kapo.ee/en/"],
  ["err-news", "rss", "https://news.err.ee/rss"],
  ["err-rus", "rss", "https://rus.err.ee/rss"],
  ["postimees-en", "rss", "https://news.postimees.ee/rss"],
  ["delfi-ee-rus", "rss", "https://rus.delfi.ee/rss", "https://rus.delfi.ee/"],
  // Latvia
  ["lv-mod", "rss", "https://www.mod.gov.lv/en/rss.xml", "https://www.mod.gov.lv/en"],
  ["lv-mil", "rss", "https://www.mil.lv/en/rss.xml", "https://www.mil.lv/en"],
  ["lsm-en", "rss", "https://eng.lsm.lv/rss/"],
  ["lsm-ru", "rss", "https://rus.lsm.lv/rss/"],
  ["delfi-lv-rus", "rss", "https://rus.delfi.lv/rss", "https://rus.delfi.lv/"],
  ["leta", "rss", "https://www.leta.lv/eng/rss/", "https://www.leta.lv/eng/"],
  // Lithuania
  ["lt-kam", "rss", "https://kam.lt/en/feed/", "https://kam.lt/en/"],
  ["lt-vsd", "rss", "https://www.vsd.lt/en/feed/", "https://www.vsd.lt/en/"],
  ["lrt-en", "rss", "https://www.lrt.lt/en/news-in-english?rss", "https://www.lrt.lt/en/news-in-english"],
  ["lrt-ru", "rss", "https://www.lrt.lt/ru/novosti?rss", "https://www.lrt.lt/ru/novosti"],
  ["15min", "rss", "https://www.15min.lt/rss"],
  ["delfi-lt", "rss", "https://www.delfi.lt/rss/feeds/daily.xml", "https://www.delfi.lt/"],
  // Poland
  ["pl-mon", "rss", "https://www.gov.pl/web/obrona-narodowa/rss", "https://www.gov.pl/web/obrona-narodowa"],
  ["pl-dorsz", "rss", "https://www.wojsko-polskie.pl/dorsz/rss/", "https://www.wojsko-polskie.pl/dorsz/"],
  ["pap-en", "rss", "https://www.pap.pl/en/rss.xml", "https://www.pap.pl/en"],
  ["pap", "rss", "https://www.pap.pl/rss.xml", "https://www.pap.pl/"],
  ["tvn24", "rss", "https://tvn24.pl/najnowsze.xml"],
  ["rmf24", "rss", "https://www.rmf24.pl/fakty/feed"],
  ["rp", "rss", "https://www.rp.pl/rss_main"],
  ["onet", "rss", "https://wiadomosci.onet.pl/.feed"],
  ["notesfrompoland", "rss", "https://notesfrompoland.com/feed/"],
  ["defence24", "rss", "https://defence24.com/rss", "https://defence24.com/"],
  ["defence24-pl", "rss", "https://defence24.pl/rss", "https://defence24.pl/"],
  // Sweden
  ["se-forsvarsmakten", "rss", "https://www.forsvarsmakten.se/sv/aktuellt/rss/", "https://www.forsvarsmakten.se/sv/aktuellt/"],
  ["se-sapo", "rss", "https://www.sakerhetspolisen.se/rss", "https://www.sakerhetspolisen.se/"],
  ["se-regeringen-fo", "rss", "https://www.regeringen.se/Filter/RssFeed?filterType=Taxonomy&filterByType=FilterablePageBase&preFilteredCategories=1293", "https://www.regeringen.se/"],
  ["svt", "rss", "https://www.svt.se/nyheter/rss.xml"],
  ["sr-ekot", "rss", "https://api.sr.se/api/rss/program/83"],
  ["dn", "rss", "https://www.dn.se/rss/"],
  ["svd", "rss", "https://www.svd.se/feed/articles.rss"],
  // Norway
  ["no-forsvaret", "rss", "https://www.forsvaret.no/rss", "https://www.forsvaret.no/aktuelt"],
  ["nrk", "rss", "https://www.nrk.no/toppsaker.rss"],
  ["nrk-nordland", "rss", "https://www.nrk.no/nordland/toppsaker.rss"],
  ["nrk-tromsfinnmark", "rss", "https://www.nrk.no/tromsogfinnmark/toppsaker.rss"],
  ["vg", "rss", "https://www.vg.no/rss/feed"],
  ["aftenposten", "rss", "https://www.aftenposten.no/rss"],
  ["highnorthnews", "rss", "https://www.highnorthnews.com/en/rss.xml", "https://www.highnorthnews.com/en"],
  ["barentsobserver", "rss", "https://www.thebarentsobserver.com/rss", "https://www.thebarentsobserver.com/"],
  // Denmark
  ["dk-fe", "rss", "https://www.fe-ddis.dk/rss", "https://www.fe-ddis.dk/"],
  ["dk-forsvaret", "rss", "https://www.forsvaret.dk/da/nyheder/rss", "https://www.forsvaret.dk/da/nyheder/"],
  ["dr", "rss", "https://www.dr.dk/nyheder/service/feeds/allenyheder"],
  ["tv2-dk", "rss", "https://feeds.tv2.dk/nyheder/rss"],
  ["berlingske", "rss", "https://www.berlingske.dk/content/rss"],
  // Germany
  ["de-bundeswehr", "rss", "https://www.bundeswehr.de/service/rss", "https://www.bundeswehr.de/de/aktuelles"],
  ["de-bmvg", "rss", "https://www.bmvg.de/service/rss", "https://www.bmvg.de/de/aktuelles"],
  ["tagesschau", "rss", "https://www.tagesschau.de/xml/rss2"],
  ["dw-en", "rss", "https://rss.dw.com/rdf/rss-en-all"],
  ["dw-ru", "rss", "https://rss.dw.com/rdf/rss-ru-all"],
  ["spiegel", "rss", "https://www.spiegel.de/ausland/index.rss"],
  // UK / US / others official
  ["uk-mod", "rss", "https://www.gov.uk/government/organisations/ministry-of-defence.atom"],
  ["uk-fcdo-russia", "rss", "https://www.gov.uk/search/news-and-communications.atom?world_locations%5B%5D=russia"],
  ["us-dod", "rss", "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=20"],
  ["us-eucom", "rss", "https://www.eucom.mil/rss", "https://www.eucom.mil/"],
  ["us-state", "rss", "https://www.state.gov/rss-feed/press-releases/feed/"],
  ["ro-mapn", "rss", "https://www.mapn.ro/rss", "https://www.mapn.ro/"],
  // International media
  ["bbc-europe", "rss", "https://feeds.bbci.co.uk/news/world/europe/rss.xml"],
  ["bbc-russian", "rss", "https://feeds.bbci.co.uk/russian/rss.xml"],
  ["guardian-russia", "rss", "https://www.theguardian.com/world/russia/rss"],
  ["guardian-nato", "rss", "https://www.theguardian.com/world/nato/rss"],
  ["france24-europe", "rss", "https://www.france24.com/en/europe/rss"],
  ["euronews", "rss", "https://www.euronews.com/rss?level=theme&name=news"],
  ["politico-eu", "rss", "https://www.politico.eu/feed/"],
  ["sky-world", "rss", "https://feeds.skynews.com/feeds/rss/world.xml"],
  ["rferl", "rss", "https://www.rferl.org/api/zrqiteuuir"],
  ["svoboda", "rss", "https://www.svoboda.org/api/zrqiteuuir"],
  ["meduza", "rss", "https://meduza.io/rss/all"],
  ["meduza-en", "rss", "https://meduza.io/rss/en/all"],
  ["novayagazeta-eu", "rss", "https://novayagazeta.eu/feed/rss"],
  ["moscowtimes", "rss", "https://www.themoscowtimes.com/rss/news"],
  ["kyivindependent", "rss", "https://kyivindependent.com/rss/"],
  // Defence media
  ["defensenews", "rss", "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml"],
  ["breakingdefense", "rss", "https://breakingdefense.com/feed/"],
  ["twz", "rss", "https://www.twz.com/feed"],
  ["ukdj", "rss", "https://ukdefencejournal.org.uk/feed/"],
  ["navalnews", "rss", "https://www.navalnews.com/feed/"],
  ["militarnyi", "rss", "https://mil.in.ua/en/feed/"],
  ["euromaidan-press", "rss", "https://euromaidanpress.com/feed/"],
  // Russia / Belarus official + state media
  ["kremlin-en", "rss", "http://en.kremlin.ru/events/all/feed"],
  ["kremlin-ru", "rss", "http://kremlin.ru/events/all/feed"],
  ["mid-ru", "rss", "https://mid.ru/ru/rss.php", "https://mid.ru/ru/"],
  ["tass-en", "rss", "https://tass.com/rss/v2.xml"],
  ["tass-ru", "rss", "https://tass.ru/rss/v2.xml"],
  ["ria", "rss", "https://ria.ru/export/rss2/archive/index.xml"],
  ["interfax", "rss", "https://www.interfax.ru/rss.asp"],
  ["kommersant", "rss", "https://www.kommersant.ru/RSS/news.xml"],
  ["belta-en", "rss", "https://eng.belta.by/rss", "https://eng.belta.by/"],
  ["belta-ru", "rss", "https://www.belta.by/rss", "https://www.belta.by/"],
  ["by-president", "rss", "https://president.gov.by/ru/rss", "https://president.gov.by/ru"],
  ["zerkalo", "rss", "https://news.zerkalo.io/rss/all.rss", "https://news.zerkalo.io/"],
  ["nashaniva", "rss", "https://nashaniva.com/rss", "https://nashaniva.com/"],
  // Telegram official/OSINT
  ["tg-mod_russia", "telegram", "https://t.me/s/mod_russia"],
  ["tg-MID_Russia", "telegram", "https://t.me/s/MID_Russia"],
  ["tg-modmilby", "telegram", "https://t.me/s/modmilby"],
  ["tg-pul_1", "telegram", "https://t.me/s/pul_1"],
  ["tg-CITeam", "telegram", "https://t.me/s/CITeam"],
  ["tg-belamova", "telegram", "https://t.me/s/belamova"],
  ["tg-Hajun_BY", "telegram", "https://t.me/s/Hajun_BY"],
  ["tg-nato", "telegram", "https://t.me/s/nato"],
  ["tg-rusich_army", "telegram", "https://t.me/s/rybar"],
  ["tg-kaliningrad", "telegram", "https://t.me/s/newkal"],
  ["tg-baltic_info", "telegram", "https://t.me/s/BalticSecurityMonitor"],
  // Think tanks
  ["isw", "rss", "https://understandingwar.org/feed/", "https://understandingwar.org/"],
  ["rusi", "rss", "https://www.rusi.org/rss.xml", "https://www.rusi.org/"],
  ["fiia", "rss", "https://fiia.fi/en/feed", "https://fiia.fi/en/"],
  ["icds", "rss", "https://icds.ee/en/feed/", "https://icds.ee/en/"],
  ["atlanticcouncil", "rss", "https://www.atlanticcouncil.org/feed/"],
  ["csis", "rss", "https://www.csis.org/rss", "https://www.csis.org/analysis"],
  ["rand", "rss", "https://www.rand.org/pubs.xml", "https://www.rand.org/"],
  ["cepa", "rss", "https://cepa.org/feed/"],
  ["chathamhouse", "rss", "https://www.chathamhouse.org/rss", "https://www.chathamhouse.org/"],
  ["iiss", "rss", "https://www.iiss.org/rss", "https://www.iiss.org/online-analysis/"],
  ["ecfr", "rss", "https://ecfr.eu/feed/"],
  ["dgap", "rss", "https://dgap.org/en/rss.xml", "https://dgap.org/en"],
  ["osw", "rss", "https://www.osw.waw.pl/en/rss.xml", "https://www.osw.waw.pl/en"],
  ["pism", "rss", "https://pism.pl/rss", "https://pism.pl/"],
  ["nupi", "rss", "https://www.nupi.no/en/rss", "https://www.nupi.no/en"],
  ["diis", "rss", "https://www.diis.dk/en/rss", "https://www.diis.dk/en"],
  ["ui-se", "rss", "https://www.ui.se/rss", "https://www.ui.se/english/"],
  ["liia", "rss", "https://www.liia.lv/en/rss", "https://www.liia.lv/en"],
  ["warontherocks", "rss", "https://warontherocks.com/feed/"],
  ["jamestown", "rss", "https://jamestown.org/feed/"],
  ["riddle", "rss", "https://ridl.io/feed/", "https://ridl.io/"],
  ["carnegie-politika", "rss", "https://carnegieendowment.org/rss/russia-eurasia", "https://carnegieendowment.org/russia-eurasia"],
  ["fpri", "rss", "https://www.fpri.org/feed/"],
  // OSINT
  ["bellingcat", "rss", "https://www.bellingcat.com/feed/"],
  ["cir", "rss", "https://www.info-res.org/feed/", "https://www.info-res.org/"],
  ["informnapalm", "rss", "https://informnapalm.org/en/feed/"],
  ["frontelligence", "rss", "https://frontelligence.substack.com/feed"],
  ["cit-en", "rss", "https://citeam.org/feed/", "https://citeam.org/"],
  ["geoconfirmed", "rss", "https://geoconfirmed.org/rss", "https://geoconfirmed.org/"],
  ["dfrlab", "rss", "https://dfrlab.org/feed/"],
  ["insider", "rss", "https://theins.ru/feed", "https://theins.ru/"],
  ["agentstvo", "rss", "https://www.agents.media/feed/", "https://www.agents.media/"],
  ["istories", "rss", "https://istories.media/rss/", "https://istories.media/"],
];

const out: unknown[] = [];
async function probe([key, kind, url, home]: (typeof C)[number]) {
  const t0 = Date.now();
  try {
    if (kind === "telegram") {
      const items = await telegramCollector.collect({ url } as SourceRow);
      return { key, kind, url, ok: items.length > 0, n: items.length, newest: items[0]?.publishedAt, sample: items[0]?.title };
    }
    const { text } = await fetchText(url);
    const items = await parseFeed(text);
    if (!items.length) throw new Error("empty feed");
    const newest = items.map((i) => i.publishedAt).filter(Boolean).sort().at(-1);
    return { key, kind, url, ok: true, n: items.length, newest, sample: items[0].title, ms: Date.now() - t0 };
  } catch (e) {
    const err = (e as Error).message.slice(0, 80);
    if (kind === "rss") {
      const found = await discoverFeed(home ?? new URL(url).origin).catch(() => null);
      if (found && found !== url) {
        try {
          const items = await parseFeed((await fetchText(found)).text);
          const newest = items.map((i) => i.publishedAt).filter(Boolean).sort().at(-1);
          return { key, kind, url: found, ok: items.length > 0, discovered: true, n: items.length, newest, sample: items[0]?.title };
        } catch {
          /* fallthrough */
        }
      }
    }
    return { key, kind, url, ok: false, err };
  }
}

const queue = [...C];
await Promise.all(
  Array.from({ length: 10 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) out.push(await probe(c));
  }),
);
console.log(JSON.stringify(out, null, 1));
