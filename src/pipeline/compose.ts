import { DomainResolver } from "../domains.ts";
import { escapeHtml as e, domainOf } from "../util.ts";
import type { Analysis } from "./analyze.ts";

export const TELEGRAM_LIMIT = 4096;

/** Telegram counts message length in UTF-16 code units after entity parsing. */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, "x").length;
}

export function marker(a: Pick<Analysis, "signal">, importance: number, breaking: boolean): string {
  if (breaking) return "🚨 СРОЧНО";
  if (a.signal === "counter") return "🟢";
  if (importance >= 80) return "🔴";
  if (importance >= 65) return "🟠";
  return "🟡";
}

// Patterns that would make the post an operational tracking tool.
const COORDINATES = [
  /\b\d{1,2}[.,]\d{3,}\s*°?\s*[NSСЮ]?\s*[,;]?\s*\d{1,3}[.,]\d{3,}\s*°?\s*[EWВЗ]?\b/i,
  /\b\d{1,3}°\s*\d{1,2}['′]\s*\d{0,2}/,
  /\bMGRS\b|\b\d{2}[A-Z]{3}\s?\d{4,5}\s?\d{4,5}\b/,
];

export interface ComposeIssue {
  code: string;
  detail: string;
}

/** Pre-publication checks on generated text (the editorial checklist's mechanical part). */
export function checkText(a: Analysis): ComposeIssue[] {
  const issues: ComposeIssue[] = [];
  const generated = [a.headline_ru, a.what_ru, a.why_ru, a.confirmation_ru, a.context_ru, a.counter_evidence_ru, a.watch_ru]
    .filter(Boolean)
    .join("\n");
  if (/https?:\/\/|t\.me\/|www\./i.test(generated)) issues.push({ code: "generated_link", detail: "модель вставила ссылку в текст" });
  if (COORDINATES.some((r) => r.test(generated))) issues.push({ code: "coordinates", detail: "в тексте похоже на точные координаты" });
  if (!/[а-яё]/i.test(a.headline_ru) || (a.headline_ru.match(/[a-z]/gi)?.length ?? 0) > a.headline_ru.length * 0.5)
    issues.push({ code: "not_russian", detail: "заголовок не на русском" });
  if (a.headline_ru.length < 15) issues.push({ code: "short_headline", detail: "слишком короткий заголовок" });
  // A FACT must not rest on one side's claim: if the only FACT statements are attributed to a party's officials, flag.
  for (const s of a.statements) {
    if (s.type === "FACT" && /минобороны|мид|кремл|песков|захаров|ministry|kremlin|spokes/i.test(s.attributed_to))
      issues.push({ code: "claim_as_fact", detail: `«${s.text_ru.slice(0, 60)}…» помечено FACT, но приписано ${s.attributed_to}` });
  }
  return issues;
}

export function sourceLinks(urls: string[], resolver: DomainResolver): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const u of urls) {
    const d = domainOf(u);
    const name = d === "t.me" ? `t.me/${u.split("/")[3] ?? ""}` : resolver.resolve(d).known ? resolver.resolve(d).name : d;
    if (seen.has(name)) continue;
    seen.add(name);
    links.push(`<a href="${e(u)}">${e(name)}</a>`);
  }
  return links.join(" · ");
}

export function renderPost(opts: {
  a: Analysis;
  importance: number;
  breaking: boolean;
  isUpdate: boolean;
  resolver: DomainResolver;
}): string {
  const { a, importance, breaking, isUpdate, resolver } = opts;
  const head = `${marker(a, importance, breaking)} ${isUpdate ? "Обновление: " : ""}<b>${e(a.headline_ru)}</b>`;
  const parts = [head, e(a.what_ru), e(a.why_ru), e(a.confirmation_ru)];
  // At most four paragraphs: counter-evidence outranks background context.
  if (a.counter_evidence_ru) parts.push(`<i>Контрсигналы:</i> ${e(a.counter_evidence_ru)}`);
  else if (a.context_ru) parts.push(`<i>Контекст:</i> ${e(a.context_ru)}`);
  parts.push(`Источники: ${sourceLinks(a.source_urls, resolver)}`);
  const tags = a.hashtags.map((t) => "#" + t.replace(/[^\p{L}\p{N}_]+/gu, "")).filter((t) => t.length > 2);
  if (tags.length) parts.push(tags.join(" "));
  let text = parts.filter(Boolean).join("\n\n");
  // Trim optional blocks before ever exceeding Telegram's limit.
  if (visibleLength(text) > TELEGRAM_LIMIT) text = parts.filter((p) => !p.startsWith("<i>Контекст")).join("\n\n");
  if (visibleLength(text) > TELEGRAM_LIMIT) throw new Error("post exceeds Telegram limit");
  return text;
}
