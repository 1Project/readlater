import type { Timestamp } from 'firebase/firestore';

export type ItemType = 'article' | 'tweet' | 'paper' | 'pdf' | 'epub' | 'video' | 'other';
export type ItemLocation = 'library' | 'feed';
export type ItemStatus = 'unread' | 'archived';
export type FetchStatus = 'uploading' | 'pending' | 'processing' | 'done' | 'error';

export interface StoredFile {
  path: string;
  name: string;
  contentType: string;
  size: number;
}

export interface PaperMeta {
  arxivId?: string;
  doi?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  pdfUrl?: string;
  abstract?: string;
}

export interface Item {
  id: string;
  url: string | null;
  type: ItemType;
  location: ItemLocation;
  status: ItemStatus;
  favorite: boolean;
  title: string;
  titleLocked: boolean;
  author: string | null;
  siteName: string | null;
  excerpt: string | null;
  imageUrl: string | null;
  publishedAt: Timestamp | null;
  wordCount: number | null;
  readingMinutes: number | null;
  categoryId: string | null;
  tags: string[];
  note: string;
  progress: number;
  fetchStatus: FetchStatus;
  fetchError: string | null;
  contentChunks: number;
  file: StoredFile | null;
  feedId: string | null;
  paper: PaperMeta | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  lastOpenedAt: Timestamp | null;
  archivedAt: Timestamp | null;
}

export interface Category {
  id: string;
  name: string;
  order: number;
  createdAt: Timestamp | null;
}

export interface Feed {
  id: string;
  url: string;
  title: string;
  siteUrl: string | null;
  categoryId: string | null;
  tags: string[];
  fullText: boolean;
  lastFetchedAt: Timestamp | null;
  lastError: string | null;
  createdAt: Timestamp | null;
}

export interface Highlight {
  id: string;
  itemId: string;
  text: string;
  note: string;
  prefix: string;
  suffix: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: Timestamp | null;
  lastUsedAt: Timestamp | null;
}

/** Fields the client may change on an item via updateItem(). */
export type ItemPatch = Partial<
  Pick<
    Item,
    | 'title'
    | 'titleLocked'
    | 'status'
    | 'location'
    | 'favorite'
    | 'categoryId'
    | 'tags'
    | 'note'
    | 'progress'
    | 'fetchStatus'
    | 'type'
  >
>;
