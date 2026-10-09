/** HTML sanitisation (DOMPurify on a jsdom window) + lazy-image fixes shared by all extractors. */
import createDOMPurify from 'dompurify';
import { JSDOM, VirtualConsole } from 'jsdom';
import { absolutize } from './html';

const MATH_TAGS = [
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac',
  'msqrt', 'mroot', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'mfenced', 'mover', 'munder', 'munderover',
  'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr', 'mtd', 'mlabeledtr',
];

export const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small',
  'cite', 'q', 'abbr', 'kbd', 'samp', 'var', 'br', 'hr', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr',
  'th', 'td', 'span', 'div', 'section', 'article', 'aside', 'details', 'summary', 'mark',
  ...MATH_TAGS,
];

export const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'reversed', 'open', 'dir',
  'data-page', 'data-chapter', 'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'accent',
  'columnalign', 'rowalign', 'lspace', 'rspace', 'linethickness', 'notation',
];

/** Elements removed together with their content (the rest are unwrapped when not allowed). */
const DROP_WITH_CONTENT = [
  'script', 'style', 'template', 'noembed', 'noframes', 'iframe', 'object', 'embed', 'canvas', 'button',
  'select', 'textarea', 'input', 'dialog', 'annotation', 'annotation-xml', 'audio', 'video', 'svg',
  'link', 'meta', 'head', 'title',
];

let purify: ReturnType<typeof createDOMPurify> | null = null;
let win: JSDOM['window'] | null = null;

function env() {
  if (!purify || !win) {
    win = new JSDOM('<!doctype html><html><body></body></html>', { virtualConsole: new VirtualConsole() }).window;
    purify = createDOMPurify(win as unknown as Parameters<typeof createDOMPurify>[0]);
  }
  return { purify, win };
}

const LAZY_SRC_ATTRS = [
  'data-src', 'data-lazy-src', 'data-original', 'data-orig-src', 'data-actualsrc', 'data-hi-res-src',
  'data-full-src', 'data-lazyload', 'data-echo', 'data-url', 'data-img-src', 'data-image', 'data-srcset-fallback',
];
const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'srcset'];

/** Parse a srcset attribute into candidates. */
export function parseSrcset(srcset: string): { url: string; w: number; x: number }[] {
  const out: { url: string; w: number; x: number }[] = [];
  let i = 0;
  const s = srcset.trim();
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    let url = '';
    while (i < s.length && !/\s/.test(s[i])) url += s[i++];
    let desc = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      while (i < s.length && s[i] !== ',') desc += s[i++];
    }
    if (!url) continue;
    const d = desc.trim();
    const w = /^(\d+)w$/i.exec(d);
    const x = /^(\d*\.?\d+)x$/i.exec(d);
    out.push({ url, w: w ? Number(w[1]) : 0, x: x ? Number(x[1]) : w ? 0 : 1 });
  }
  return out;
}

/** Pick a good candidate: largest width ≤ 2000px (else the smallest above), or the highest density. */
export function bestFromSrcset(srcset: string): string | null {
  const c = parseSrcset(srcset);
  if (!c.length) return null;
  const withW = c.filter((x) => x.w > 0);
  if (withW.length) {
    const ok = withW.filter((x) => x.w <= 2000).sort((a, b) => b.w - a.w);
    if (ok.length) return ok[0].url;
    return withW.sort((a, b) => a.w - b.w)[0].url;
  }
  return c.sort((a, b) => b.x - a.x)[0].url;
}

function isPlaceholderSrc(src: string | null): boolean {
  if (!src || !src.trim()) return true;
  const s = src.trim().toLowerCase();
  if (s.startsWith('data:')) return true;
  return /(^|\/)(blank|spacer|pixel|transparent|placeholder|lazy|loading|grey|gray)[\w-]*\.(gif|png|svg|jpg)(\?|$)/.test(s);
}

const TRACKER_RE =
  /(feeds\.feedburner\.com\/~r|feedburner\.com\/~ff|pixel\.wp\.com|stats\.wordpress\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.com\/tr|pixel\.quantserve|scorecardresearch\.com|\/pixel\.(gif|png)|\/beacon[./?]|\/open\.(gif|png)|\/track(ing)?\/(open|pixel)|mf\.gif|\/1x1\.(gif|png)|substackcdn\.com\/open|list-manage\.com\/track|mailchimp\.com\/track|\/e\/o\/|matomo\.php|piwik\.php)/i;

function isTrackingPixel(img: Element): boolean {
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  if ((img.hasAttribute('width') && w > 0 && w <= 2) || (img.hasAttribute('height') && h > 0 && h <= 2)) return true;
  const style = (img.getAttribute('style') ?? '').replace(/\s+/g, '');
  if (/(^|;)(width|height):[01]px/i.test(style) || /display:none/i.test(style)) return true;
  return TRACKER_RE.test(img.getAttribute('src') ?? '');
}

/**
 * Fix lazy-loaded images in place: data-src/srcset → src, <picture><source>, <noscript> fallbacks;
 * remove tracking pixels. Works on a Document, Element or DocumentFragment.
 */
export function fixLazyImages(root: ParentNode): void {
  // <noscript> fallbacks: replace the preceding placeholder or just unwrap.
  for (const ns of Array.from(root.querySelectorAll('noscript'))) {
    const doc = ns.ownerDocument;
    // With scripting disabled the contents are parsed as markup; otherwise they are raw text.
    let imgs = Array.from(ns.querySelectorAll('img'));
    if (!imgs.length && /<img\b/i.test(ns.textContent ?? '')) {
      const tpl = doc.createElement('template');
      tpl.innerHTML = ns.textContent ?? '';
      ns.replaceChildren(tpl.content);
      imgs = Array.from(ns.querySelectorAll('img'));
    }
    if (!imgs.length) {
      ns.remove();
      continue;
    }
    const prev = ns.previousElementSibling;
    let prevImg: Element | null = null;
    if (prev?.tagName === 'IMG') prevImg = prev;
    else if (prev && prev.children.length === 1 && prev.firstElementChild?.tagName === 'IMG') prevImg = prev.firstElementChild;
    if (prevImg) {
      const ok = !isPlaceholderSrc(prevImg.getAttribute('src')) && !LAZY_SRC_ATTRS.some((a) => prevImg.hasAttribute(a));
      if (ok) {
        ns.remove();
        continue;
      }
      prevImg.remove();
    }
    ns.replaceWith(...Array.from(ns.childNodes));
  }

  for (const img of Array.from(root.querySelectorAll('img'))) {
    let src = img.getAttribute('src');
    if (isPlaceholderSrc(src)) {
      let found: string | null = null;
      for (const a of LAZY_SRC_ATTRS) {
        const v = img.getAttribute(a);
        if (v && !isPlaceholderSrc(v) && !/\s\d+[wx]\s*(,|$)/.test(v)) {
          found = v.trim();
          break;
        }
      }
      if (!found) {
        for (const a of LAZY_SRCSET_ATTRS) {
          const v = img.getAttribute(a);
          if (v) {
            found = bestFromSrcset(v);
            if (found) break;
          }
        }
      }
      if (!found && img.parentElement?.tagName === 'PICTURE') {
        for (const source of Array.from(img.parentElement.querySelectorAll('source'))) {
          const v = source.getAttribute('srcset') ?? source.getAttribute('data-srcset');
          if (v) {
            found = bestFromSrcset(v);
            if (found) break;
          }
        }
      }
      if (found) {
        img.setAttribute('src', found);
        src = found;
      }
    }
    if (isTrackingPixel(img) || isPlaceholderSrc(src)) img.remove();
  }
}

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

const PRUNE_IF_EMPTY = new Set(['P', 'DIV', 'SPAN', 'SECTION', 'ARTICLE', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'EM', 'STRONG', 'B', 'I', 'U', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'DETAILS', 'TABLE', 'TBODY', 'THEAD', 'TR', 'PRE', 'CODE', 'SMALL', 'SUP', 'SUB']);

function isEmptyEl(el: Element): boolean {
  if ((el.textContent ?? '').replace(/[\s ​]+/g, '') !== '') return false;
  return !el.querySelector('img,hr,math,td,th');
}

/**
 * Sanitize HTML with the spec allow-list: no scripts/styles/handlers/iframes, absolute http(s)/mailto links
 * and http(s) images only (relative URLs are resolved against `baseUrl`, dropped without one), empty
 * paragraphs removed, in-page anchors unwrapped.
 */
export function sanitizeHtml(html: string, baseUrl?: string): string {
  if (!html || !html.trim()) return '';
  const { purify, win } = env();
  const doc = win.document;

  // Pre-pass on an inert template: lazy images, tracking pixels, MathML annotations.
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const frag = tpl.content;
  fixLazyImages(frag);
  for (const el of Array.from(frag.querySelectorAll(DROP_WITH_CONTENT.join(',')))) el.remove();
  // Resolve URLs before DOMPurify drops data-* attributes.
  for (const a of Array.from(frag.querySelectorAll('a'))) {
    const raw = (a.getAttribute('href') ?? '').trim();
    if (!raw || raw.startsWith('#')) {
      a.removeAttribute('href');
      continue;
    }
    const abs = absolutize(raw, baseUrl);
    if (abs) a.setAttribute('href', abs);
    else a.removeAttribute('href');
  }
  for (const img of Array.from(frag.querySelectorAll('img'))) {
    const abs = absolutize(img.getAttribute('src'), baseUrl);
    if (abs && /^https?:/i.test(abs)) img.setAttribute('src', abs);
    else img.remove();
  }
  const pre = tpl.innerHTML;

  const body = purify.sanitize(pre, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ADD_FORBID_CONTENTS: DROP_WITH_CONTENT,
    KEEP_CONTENT: true,
    RETURN_DOM: true,
  }) as unknown as HTMLElement;

  // Post-pass: enforce URL policy again (defence in depth) and prune empties.
  for (const a of Array.from(body.querySelectorAll('a'))) {
    const href = a.getAttribute('href');
    const abs = href ? absolutize(href) : null;
    if (!abs) {
      unwrap(a);
      continue;
    }
    a.setAttribute('href', abs);
  }
  for (const img of Array.from(body.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src || !/^https?:\/\//i.test(src)) img.remove();
  }
  for (const el of Array.from(body.querySelectorAll('[src],[href]'))) {
    for (const attr of ['src', 'href']) {
      const v = el.getAttribute(attr);
      if (v != null && !/^(https?:|mailto:)/i.test(v.trim())) el.removeAttribute(attr);
    }
  }
  const all = Array.from(body.querySelectorAll('*')).reverse();
  for (const el of all) {
    if (PRUNE_IF_EMPTY.has(el.tagName) && el.parentNode && isEmptyEl(el)) {
      el.remove();
    }
  }
  // Collapse runs of <br>.
  let out = body.innerHTML.replace(/(?:<br>\s*){3,}/g, '<br><br>');
  out = out.replace(/^\s*(?:<br>\s*)+|(?:<br>\s*)+$/g, '');
  return out.trim();
}
