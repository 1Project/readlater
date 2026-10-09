/** OPML parsing (subscription lists exported by other readers). Pure, unit-testable. */
import { XMLParser } from 'fast-xml-parser';
import { collapseWs, httpUrl } from '../extract/html';
import { decodeHTML as decodeEntities } from 'entities';

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl: string | null;
}

/** Most feeds an OPML file may list (the per-user feed cap is applied by the caller). */
export const MAX_OPML_FEEDS = 2000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  attributesGroupName: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

/** Attribute lookup ignoring case (xmlUrl / xmlurl / XMLURL all occur in the wild). */
function attrCI(attrs: Obj, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(attrs)) if (k.toLowerCase() === want && typeof v === 'string') return v.trim();
  return '';
}

function walk(outlines: unknown, out: OpmlFeed[], seen: Set<string>, depth: number): void {
  if (depth > 20) return;
  for (const o of arr(outlines)) {
    if (!isObj(o)) continue;
    const attrs = isObj(o['@']) ? (o['@'] as Obj) : {};
    const xmlUrl = httpUrl(attrCI(attrs, 'xmlUrl'));
    if (xmlUrl && !seen.has(xmlUrl) && out.length < MAX_OPML_FEEDS) {
      seen.add(xmlUrl);
      const title = collapseWs(decodeEntities(attrCI(attrs, 'title') || attrCI(attrs, 'text')));
      out.push({ title: title.slice(0, 300), xmlUrl, htmlUrl: httpUrl(attrCI(attrs, 'htmlUrl')) });
    }
    walk(o.outline, out, seen, depth + 1);
  }
}

/** All feeds in an OPML document (nested folders flattened, duplicates removed, document order). Throws on invalid input. */
export function parseOpml(opml: string): OpmlFeed[] {
  const text = (opml ?? '').replace(/^﻿/, '').trim();
  if (!text.startsWith('<')) throw new Error('This is not an OPML file');
  let doc: Obj;
  try {
    doc = parser.parse(text) as Obj;
  } catch {
    throw new Error('This OPML file is not valid XML');
  }
  const root = Object.entries(doc).find(([k]) => k.toLowerCase() === 'opml')?.[1];
  if (!isObj(root)) throw new Error('This is not an OPML file');
  const body = Object.entries(root).find(([k]) => k.toLowerCase() === 'body')?.[1];
  const out: OpmlFeed[] = [];
  const seen = new Set<string>();
  for (const b of arr(body)) if (isObj(b)) walk(b.outline, out, seen, 0);
  return out;
}
