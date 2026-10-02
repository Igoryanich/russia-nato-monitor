// Free, deterministic, multilingual screen in front of the LLM. Terms are word
// *prefixes* (inflected languages), anchored on a left word boundary. Recall
// matters more than precision here: the LLM triage removes what slips through.

const ACTORS = [
  // en / ru / be
  "russia", "kremlin", "putin", "moscow", "belarus", "lukashenk", "nato", "kaliningrad", "shoigu", "lavrov", "peskov", "medvedev", "gerasimov", "belousov",
  "росси", "российск", "кремл", "путин", "москв", "белорус", "беларус", "лукашенк", "нато", "калининград", "шойгу", "лавров", "песков", "медведев", "герасимов", "белоусов", "альянс",
  // fi / sv / no / da
  "venäj", "kreml", "valko-venäj", "ryssland", "rysk", "vitryssland", "russland", "russisk", "rusland", "hviderusland",
  // et / lv / lt / pl / de
  "venemaa", "vene ", "valgevene", "krievij", "krievu", "baltkrievij", "rusij", "rusų", "baltarusij", "rosj", "rosyjsk", "kreml", "białoru", "russisch", "weißrussland",
];

const SECURITY = [
  "military", "army", "troop", "soldier", "drone", "airspace", "fighter jet", "jets", "intercept", "exercise", "drill", "sabotage", "espionage", "spy", "spies",
  "cyberattack", "cyber attack", "nuclear", "missile", "mobili", "reservist", "border", "warship", "submarine", "navy", "naval", "fleet", "deploy", "brigade",
  "division", "defence", "defense", "intelligence", "threat", "escalat", "jamming", "gps", "undersea cable", "pipeline", "arson", "incursion", "provocation",
  "war ", "attack", "air policing", "air defence", "air defense", "deterren", "sanction", "ultimatum", "blockade",
  "войск", "военн", "учени", "беспилот", "дрон", "воздушн", "истребител", "перехват", "диверс", "шпион", "кибератак", "ядерн", "ракет", "мобилиз", "резервист",
  "границ", "флот", "корабл", "подлод", "развертыв", "развёртыв", "бригад", "дивизи", "оборон", "развед", "угроз", "эскалац", "глушен", "кабел", "поджог",
  "провокац", "войн", "атак", "удар", "сдерживан", "санкци", "блокад", "ультиматум",
  "armeij", "sotila", "puolustu", "droon", "ilmatil", "harjoitu", "sabot", "vakoil", "ydinase", "ohjus", "rajavartio", "itäraj", "laivast", "sukellusvene", "tiedustel", "uhka", "sota",
  "militär", "försvar", "drönare", "luftrum", "övning", "spion", "kärnvap", "gräns", "marinen", "ubåt", "underrättelse", "krig",
  "militær", "forsvar", "luftrom", "øvelse", "sabotasje", "atomvåpen", "grense", "etterretning", "krig", "droner", "luftrum",
  "kaitsev", "sõja", "õhuruum", "õppus", "piirivalv", "luure",
  "armij", "militār", "bezpilot", "drons", "gaisa telp", "mācīb", "diversij", "spieg", "robež", "izlūk", "draud", "karš", "kara ",
  "kariuomen", "karin", "dron", "oro erdv", "pratyb", "šnip", "pasienio", "žvalgyb", "grėsm", "karas", "karo ",
  "wojsk", "wojsko", "armi", "przestrze", "ćwicze", "sabota", "dywersj", "szpieg", "granic", "okręt", "wywiad", "zagroż", "wojn",
  "bundeswehr", "truppe", "drohne", "luftraum", "manöver", "übung", "atomwaff", "rakete", "grenze", "geheimdienst", "bedrohung", "krieg",
];

const STRONG = [
  "kaliningrad", "калининград", "suwał", "suwalk", "сувалк", "baltic sea", "балтийск", "itämer", "östersjön", "østersjø", "läänemer", "bałtyk", "baltijas jūr", "baltijos jūr",
  "eastern flank", "восточн фланг", "восточном фланг", "article 5", "article 4", "статья 5", "статьи 5", "hybrid", "гибридн", "hybridi", "hybrid",
  "shadow fleet", "теневой флот", "теневого флот", "varjolaivast", "skuggflott", "flota cieni", "baltic sentry", "eastern sentry", "air policing",
  "gulf of finland", "финский залив", "финском залив", "suomenlah", "narva", "нарв", "zapad", "запад-20", "iskander", "искандер", "орешник", "oreshnik",
  "belarus", "беларус", "белорус", "nato", "нато",
];

function compile(terms: string[]): RegExp {
  const esc = [...new Set(terms)].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${esc.join("|")})`, "giu");
}

const RE_ACTORS = compile(ACTORS);
const RE_SECURITY = compile(SECURITY);
const RE_STRONG = compile(STRONG);

/** 0..4: actor present (+1), security vocabulary (+1), strong theatre/term hit (+1, +1 for several). */
export function prefilterScore(text: string): number {
  const t = text.slice(0, 5000);
  const actor = (t.match(RE_ACTORS) ?? []).length;
  const sec = (t.match(RE_SECURITY) ?? []).length;
  const strong = (t.match(RE_STRONG) ?? []).length;
  return (actor ? 1 : 0) + (sec ? 1 : 0) + (strong ? 1 : 0) + (strong >= 3 || (actor >= 2 && sec >= 3) ? 1 : 0);
}
