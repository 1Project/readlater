/**
 * Client-side sanitising of item content HTML (defence in depth: the server already sanitises).
 *
 * Exports:
 *   sanitizeContent(html: string): string   allow-list per docs/SPEC.md; links open in a new tab with
 *                                           rel="noopener noreferrer"; images get loading="lazy",
 *                                           decoding="async", referrerpolicy="no-referrer"; only
 *                                           http(s)/mailto links and http(s)/data:image sources survive.
 *                                           The only class kept is `<p class="rl-note">` (an extractor note such
 *                                           as "Loaded from the Internet Archive…", styled by reader.css).
 *   hasChapters(html: string): boolean      content contains EPUB chapter sections
 */
import DOMPurify from 'dompurify';

const HTML_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'ul', 'ol',
  'li', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th',
  'td', 'caption', 'span', 'div', 'section', 'article', 'aside', 'details', 'summary', 'mark', 'dl', 'dt', 'dd',
  'abbr', 'cite', 'q', 'small', 'del', 'ins', 'kbd', 'samp', 'var', 'time',
];

const MATH_TAGS = [
  'math', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover',
  'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mspace', 'mstyle', 'semantics', 'annotation', 'mpadded',
  'mphantom', 'menclose', 'mmultiscripts', 'mprescripts', 'none',
];

/** The one class the server keeps (functions/src/extract/sanitize.ts NOTE_CLASS). */
const NOTE_CLASS = 'rl-note';

const ATTRS = [
  'class', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'data-chapter', 'data-page', 'open', 'datetime',
  'display', 'mathvariant', 'encoding', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'columnalign',
  'linethickness', 'lspace', 'rspace', 'notation',
];

let purifier: ReturnType<typeof DOMPurify> | null = null;

function getPurifier() {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    if (el.hasAttribute?.('class')) {
      if (tag === 'p' && (el.getAttribute('class') ?? '').trim() === NOTE_CLASS) el.setAttribute('class', NOTE_CLASS);
      else el.removeAttribute('class');
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (href && !/^(https?:|mailto:)/i.test(href.trim())) el.removeAttribute('href');
      if (el.hasAttribute('href')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'img') {
      const src = (el.getAttribute('src') ?? '').trim();
      if (!/^(https?:|data:image\/(png|jpe?g|gif|webp|avif);)/i.test(src)) {
        el.remove();
        return;
      }
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
  });
  purifier = p;
  return p;
}

export function sanitizeContent(html: string): string {
  if (!html) return '';
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS: [...HTML_TAGS, ...MATH_TAGS],
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg'],
  }) as string;
}

export function hasChapters(html: string): boolean {
  return /<section[^>]*\bdata-chapter=/i.test(html);
}
