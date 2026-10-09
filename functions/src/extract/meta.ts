/** Page metadata from OpenGraph, Twitter cards, JSON-LD, Dublin Core and Highwire (citation_*) tags. */
import { collapseWs, httpUrl, toDate } from './html';

export interface CitationMeta {
  title: string | null;
  authors: string[];
  doi: string | null;
  pdfUrl: string | null;
  date: Date | null;
  journal: string | null;
  abstract: string | null;
  arxivId: string | null;
}

export interface PageMeta {
  title: string | null;
  author: string | null;
  siteName: string | null;
  description: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
  canonicalUrl: string | null;
  ogType: string | null;
  lang: string | null;
  citation: CitationMeta | null;
}

type Json = Record<string, unknown>;

const ARTICLE_TYPES = new Set([
  'article', 'newsarticle', 'blogposting', 'report', 'scholarlyarticle', 'techarticle', 'socialmediaposting',
  'liveblogposting', 'opinionnewsarticle', 'analysisnewsarticle', 'reportagenewsarticle', 'reviewnewsarticle',
  'backgroundnewsarticle', 'review', 'medicalscholarlyarticle', 'discussionforumposting', 'videoobject',
  'podcastepisode', 'creativework', 'howto', 'recipe', 'book', 'chapter',
]);

const TITLE_SEPS = [' | ', ' - ', ' – ', ' — ', ' · ', ' • ', ' :: ', ' » ', ' / '];

function metaContent(doc: Document, ...keys: string[]): string | null {
  for (const k of keys) {
    const lk = k.toLowerCase();
    for (const el of Array.from(doc.querySelectorAll('meta'))) {
      const name = (el.getAttribute('property') ?? el.getAttribute('name') ?? el.getAttribute('itemprop') ?? '').toLowerCase();
      if (name === lk) {
        const v = collapseWs(el.getAttribute('content'));
        if (v) return v;
      }
    }
  }
  return null;
}

function metaAll(doc: Document, key: string): string[] {
  const lk = key.toLowerCase();
  return Array.from(doc.querySelectorAll('meta'))
    .filter((el) => (el.getAttribute('name') ?? el.getAttribute('property') ?? '').toLowerCase() === lk)
    .map((el) => collapseWs(el.getAttribute('content')))
    .filter(Boolean);
}

function parseJsonLoose(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      // Common breakage: raw control characters inside strings, trailing commas.
      return JSON.parse(s.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** All JSON-LD nodes on the page, flattened (arrays and @graph). */
export function jsonLdNodes(doc: Document): Json[] {
  const out: Json[] = [];
  const walk = (x: unknown, depth: number) => {
    if (!x || depth > 4) return;
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    if (typeof x !== 'object') return;
    const o = x as Json;
    out.push(o);
    if (o['@graph']) walk(o['@graph'], depth + 1);
    if (o.mainEntity && typeof o.mainEntity === 'object') walk(o.mainEntity, depth + 1);
  };
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'))) {
    walk(parseJsonLoose((s.textContent ?? '').trim()), 0);
  }
  return out;
}

function types(o: Json): string[] {
  const t = o['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return collapseWs(v) || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Json;
    return str(o['@value'] ?? o.name ?? o.text);
  }
  return null;
}

function names(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === 'string') return [collapseWs(v)].filter(Boolean);
  if (typeof v === 'object') {
    const o = v as Json;
    const n = o.name;
    if (Array.isArray(n)) return n.flatMap(names);
    const s = str(n) ?? [str(o.givenName), str(o.familyName)].filter(Boolean).join(' ');
    return s ? [s] : [];
  }
  return [];
}

function imageOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return imageOf(v[0]);
  if (typeof v === 'object') {
    const o = v as Json;
    return imageOf(o.url ?? o.contentUrl ?? o['@id']);
  }
  return null;
}

/** Clean an author string; drops URLs, handles "By X", caps length. */
export function cleanAuthor(a: string | null | undefined): string | null {
  let s = collapseWs(a);
  if (!s) return null;
  s = s.replace(/^(by|von|par|por|door|di)\s+/i, '').replace(/^[-–—|·:,\s]+|[-–—|·:,\s]+$/g, '');
  if (!s || /^https?:\/\//i.test(s) || /^@?[\w.]+\.(com|org|net)\b/i.test(s)) return null;
  if (s.length > 120) return null;
  return s;
}

/** Join unique author names ("A, B, C" or "A, B, C et al."). */
export function joinAuthors(list: string[], max = 4): string | null {
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const raw of list) {
    const a = cleanAuthor(raw);
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      uniq.push(a);
    }
  }
  if (!uniq.length) return null;
  return uniq.length > max ? `${uniq.slice(0, max - 1).join(', ')} et al.` : uniq.join(', ');
}

/** Strip a trailing/leading site name (" | Site", "Site - ") from a title. */
export function stripSiteName(title: string, siteName: string | null | undefined): string {
  let t = collapseWs(title);
  const site = collapseWs(siteName);
  if (site && t.length > site.length + 3) {
    const lt = t.toLowerCase();
    const ls = site.toLowerCase();
    for (const sep of TITLE_SEPS) {
      if (lt.endsWith(sep + ls)) return t.slice(0, t.length - sep.length - site.length).trim();
      if (lt.startsWith(ls + sep)) return t.slice(site.length + sep.length).trim();
    }
  }
  return t;
}

/** Clean up a <title>: strip site name; otherwise drop a short trailing segment after a separator. */
export function cleanDocTitle(title: string, siteName: string | null | undefined): string {
  const t = stripSiteName(title, siteName);
  if (t !== collapseWs(title)) return t;
  for (const sep of TITLE_SEPS) {
    const i = t.lastIndexOf(sep);
    if (i > 0) {
      const head = t.slice(0, i).trim();
      const tail = t.slice(i + sep.length).trim();
      const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
      if (wc(tail) <= 4 && wc(head) >= 3) return head;
    }
  }
  return t;
}

export function extractMeta(doc: Document, url: string): PageMeta {
  const base = doc.baseURI || url;
  const ld = jsonLdNodes(doc);
  const article =
    ld.find((o) => types(o).some((t) => ARTICLE_TYPES.has(t) && t !== 'creativework')) ??
    ld.find((o) => types(o).some((t) => ARTICLE_TYPES.has(t))) ??
    ld.find((o) => types(o).includes('webpage') && (o.headline || o.datePublished));
  const website = ld.find((o) => types(o).includes('website'));
  const org = ld.find((o) => types(o).some((t) => t === 'organization' || t === 'newsmediaorganization'));

  const siteName =
    metaContent(doc, 'og:site_name', 'application-name', 'apple-mobile-web-app-title') ??
    str((article?.publisher as Json | undefined)?.name) ??
    str(website?.name) ??
    str(org?.name);

  // Citation (Highwire Press) tags used by academic publishers, arXiv, SSRN, etc.
  const cTitle = metaContent(doc, 'citation_title', 'dc.title');
  const cAuthors = metaAll(doc, 'citation_author');
  const citation: CitationMeta | null =
    cTitle && (metaContent(doc, 'citation_doi', 'citation_pdf_url', 'citation_journal_title', 'citation_arxiv_id', 'citation_conference_title') != null)
      ? {
          title: cTitle,
          authors: cAuthors.map((a) => (/^[^,]+,\s*[^,]+$/.test(a) ? a.split(/,\s*/).reverse().join(' ') : a)),
          doi: metaContent(doc, 'citation_doi', 'dc.identifier')?.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, '') ?? null,
          pdfUrl: httpUrl(metaContent(doc, 'citation_pdf_url'), base),
          date: toDate(metaContent(doc, 'citation_publication_date', 'citation_date', 'citation_online_date', 'citation_cover_date')),
          journal: metaContent(doc, 'citation_journal_title', 'citation_conference_title', 'citation_publisher'),
          abstract: metaContent(doc, 'citation_abstract'),
          arxivId: metaContent(doc, 'citation_arxiv_id'),
        }
      : null;

  const ogTitle = metaContent(doc, 'og:title', 'twitter:title');
  const ldTitle = str(article?.headline) ?? str(article?.name);
  const docTitle = collapseWs(doc.querySelector('title')?.textContent);
  const h1s = Array.from(doc.querySelectorAll('h1'))
    .map((h) => collapseWs(h.textContent))
    .filter(Boolean);
  let title: string | null = null;
  if (ogTitle) title = stripSiteName(ogTitle, siteName);
  else if (ldTitle) title = stripSiteName(ldTitle, siteName);
  else if (citation?.title) title = citation.title;
  else if (h1s.length === 1 && h1s[0].length <= 300) title = h1s[0];
  else if (docTitle) title = cleanDocTitle(docTitle, siteName);

  const ldAuthors = names(article?.author ?? article?.creator);
  const metaAuthor =
    metaContent(doc, 'author', 'parsely-author', 'sailthru.author', 'dc.creator', 'dcterms.creator', 'citation_author', 'byl') ??
    metaContent(doc, 'article:author');
  const author = joinAuthors(ldAuthors) ?? cleanAuthor(metaAuthor);

  const publishedAt =
    toDate(metaContent(doc, 'article:published_time', 'og:article:published_time', 'published_time')) ??
    toDate(str(article?.datePublished)) ??
    toDate(metaContent(doc, 'datePublished', 'date', 'pubdate', 'publish-date', 'publish_date', 'dc.date', 'dcterms.date', 'dc.date.issued', 'sailthru.date', 'parsely-pub-date')) ??
    citation?.date ??
    toDate(str(article?.uploadDate) ?? str(article?.dateCreated)) ??
    toDate(doc.querySelector('article time[datetime], time[pubdate]')?.getAttribute('datetime'));

  const imageUrl =
    httpUrl(metaContent(doc, 'og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), base) ??
    httpUrl(imageOf(article?.image ?? article?.thumbnailUrl), base) ??
    httpUrl(doc.querySelector('link[rel="image_src"]')?.getAttribute('href'), base);

  const description =
    metaContent(doc, 'og:description', 'twitter:description', 'description', 'dc.description') ??
    str(article?.description) ??
    citation?.abstract ??
    null;

  const canonicalUrl =
    httpUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), base) ?? httpUrl(metaContent(doc, 'og:url'), base);

  return {
    title: title || null,
    author,
    siteName: siteName || null,
    description,
    imageUrl,
    publishedAt,
    canonicalUrl,
    ogType: metaContent(doc, 'og:type')?.toLowerCase() ?? null,
    lang: doc.documentElement.getAttribute('lang') || null,
    citation,
  };
}
