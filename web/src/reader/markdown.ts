/**
 * Per-document Markdown for the reader's highlights panel ("Copy as Markdown"), made for Obsidian and
 * similar note apps: YAML front matter, a heading, then one `> quote` block per highlight with its note.
 *
 * Exports:
 *   documentMarkdown(doc: MarkdownDoc, highlights: { text, note }[]): string
 *   type MarkdownDoc = { title, url, author, siteName?, tags, savedAt: Date | null, publishedAt?: Date | null }
 *   yamlString(s): string                     a double-quoted YAML scalar
 */

export interface MarkdownDoc {
  title: string;
  url: string | null;
  author: string | null;
  siteName?: string | null;
  tags: string[];
  /** When the document was saved; front matter `date`. */
  savedAt: Date | null;
  publishedAt?: Date | null;
}

/** JSON strings are valid double-quoted YAML scalars (escapes, quotes, unicode). */
export function yamlString(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, ' ').trim());
}

function isoDate(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((l) => (l.trim() ? `> ${l.trim()}` : '>'))
    .join('\n');
}

function heading(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]#<>])/g, '\\$1');
}

export function documentMarkdown(doc: MarkdownDoc, highlights: { text: string; note: string }[]): string {
  const title = doc.title.trim() || doc.url || 'Untitled';
  const fm: string[] = ['---', `title: ${yamlString(title)}`];
  if (doc.url) fm.push(`url: ${yamlString(doc.url)}`);
  if (doc.author?.trim()) fm.push(`author: ${yamlString(doc.author)}`);
  if (doc.siteName?.trim()) fm.push(`site: ${yamlString(doc.siteName)}`);
  // Obsidian tags cannot contain spaces.
  const tags = doc.tags.map((t) => t.trim().replace(/\s+/g, '-')).filter(Boolean);
  if (tags.length) fm.push('tags:', ...tags.map((t) => `  - ${yamlString(t)}`));
  const saved = isoDate(doc.savedAt);
  if (saved) fm.push(`date: ${saved}`);
  const published = isoDate(doc.publishedAt);
  if (published) fm.push(`published: ${published}`);
  fm.push('---');

  const parts: string[] = [fm.join('\n'), '', `# ${heading(title)}`];
  if (doc.url) parts.push('', `Source: <${doc.url}>`);
  for (const h of highlights) {
    if (!h.text.trim()) continue;
    parts.push('', quote(h.text));
    const note = h.note.trim();
    if (note) parts.push('', note);
  }
  return parts.join('\n') + '\n';
}
