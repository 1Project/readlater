/** Keyword extraction for the per-user search index (users/{uid}/search/{itemId}). */

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when which who will with you your ' +
    'about after all also any can could did do does had how just more most no not now only other out over same should some such up very would'
  ).split(' '),
);

export const MAX_TERMS = 4000;

/** Normalise free text into search terms (lowercase, diacritics stripped). Order of first appearance. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && t.length <= 32 && !STOPWORDS.has(t));
}

/** Unique terms, metadata first so they survive the cap. */
export function buildKeywords(parts: { meta: string[]; body: string }): string[] {
  const seen = new Set<string>();
  const add = (t: string) => {
    if (seen.size < MAX_TERMS) seen.add(t);
  };
  for (const m of parts.meta) tokenize(m).forEach(add);
  tokenize(parts.body).forEach(add);
  return [...seen];
}

/** Query terms: same normalisation, deduped, at most 8. */
export function queryTerms(q: string): string[] {
  return [...new Set(tokenize(q))].slice(0, 8);
}

/** Strip tags to plain text (cheap, for indexing). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
