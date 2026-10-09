/** Writing readable content into `items/{id}/content/{n}` chunks. */
import type { DocumentReference } from 'firebase-admin/firestore';
import { db } from './admin';

export const CHUNK_BYTES = 800 * 1024;

/** Split HTML into chunks of at most CHUNK_BYTES UTF-8 bytes, cutting only between tags when possible. */
export function chunkHtml(html: string, max = CHUNK_BYTES): string[] {
  const out: string[] = [];
  let rest = html;
  while (Buffer.byteLength(rest, 'utf8') > max) {
    // Approximate char index for max bytes, then back off to the last '>' boundary.
    let cut = Math.min(rest.length, max);
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > max) cut = Math.floor(cut * 0.9);
    const boundary = rest.lastIndexOf('>', cut);
    if (boundary > cut * 0.5) cut = boundary + 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length || !out.length) out.push(rest);
  return out;
}

/** Replace the content chunks of an item. Returns the number of chunks written. */
export async function writeContent(itemRef: DocumentReference, html: string): Promise<number> {
  const chunks = html ? chunkHtml(html) : [];
  const col = itemRef.collection('content');
  const existing = await col.listDocuments();
  const writer = db.bulkWriter();
  chunks.forEach((c, i) => writer.set(col.doc(String(i)), { index: i, html: c }));
  for (const d of existing) if (Number(d.id) >= chunks.length || Number.isNaN(Number(d.id))) writer.delete(d);
  await writer.close();
  return chunks.length;
}

/** Read the concatenated content HTML of an item. */
export async function readContent(itemRef: DocumentReference): Promise<string> {
  const snap = await itemRef.collection('content').get();
  return snap.docs
    .map((d) => ({ i: Number(d.get('index') ?? d.id), html: String(d.get('html') ?? '') }))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.html)
    .join('');
}
