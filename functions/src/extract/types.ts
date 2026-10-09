export type ItemType = 'article' | 'tweet' | 'paper' | 'pdf' | 'epub' | 'video' | 'other';

export interface PaperMeta {
  arxivId?: string;
  doi?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  pdfUrl?: string;
  abstract?: string;
}

/** Result of extracting a URL or file. */
export interface Extracted {
  type: ItemType;
  title: string | null;
  author: string | null;
  siteName: string | null;
  excerpt: string | null; // ≤ 400 chars plain text
  imageUrl: string | null;
  publishedAt: Date | null;
  html: string; // sanitized readable HTML (may be '')
  text: string; // plain text of html (for search & word count)
  wordCount: number;
  canonicalUrl?: string | null;
  paper?: PaperMeta | null;
  /** Original binary to store in Storage (e.g. a downloaded PDF). */
  file?: { buffer: Buffer; contentType: string; name: string } | null;
}

/** Callback used by EPUB extraction to store embedded images; returns a public URL. */
export type UploadImage = (name: string, data: Uint8Array, contentType: string) => Promise<string>;
