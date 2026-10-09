/**
 * Header block above the article text: title, byline (author · site · date · reading time), paper
 * authors / venue / PDF link, category + tag chips (tap → onEdit), note, link to the original.
 * Posts (tweets) get a compact variant without the big title.
 *
 * export default ArticleHeader
 * Props: { item: Item; categories: Category[] | undefined; onEdit: () => void; children?: ReactNode }
 * (children render at the end of the header, e.g. a status banner or the PDF view toggle)
 */
import type { MouseEvent, ReactNode } from 'react';
import { External, Tag } from '../components/Icons';
import { openOriginal } from '../components/itemActions';
import { formatDate, hostname, readingTime } from '../lib/format';
import type { Category, Item } from '../lib/types';
import { isNative, openExternal } from '../native';

export function openLinkNatively(e: MouseEvent<HTMLAnchorElement>): void {
  const href = e.currentTarget.href;
  if (isNative() && /^https?:/i.test(href)) {
    e.preventDefault();
    void openExternal(href);
  }
}

function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={openLinkNatively}>
      {children}
    </a>
  );
}

const MAX_AUTHORS = 8;

export default function ArticleHeader({ item, categories, onEdit, children }: { item: Item; categories: Category[] | undefined; onEdit: () => void; children?: ReactNode }) {
  const tweet = item.type === 'tweet';
  const paper = item.paper;
  const site = item.siteName || hostname(item.url);
  const date = formatDate(item.publishedAt);
  const time = tweet ? '' : readingTime(item);
  const authors = paper?.authors?.filter(Boolean) ?? [];
  // Papers list their authors above; "Niki Parmar et al." would repeat them.
  const showAuthor = item.author && !authors.length;
  // A full publication date in the byline makes the year in the venue line redundant.
  const venue = paper ? [paper.venue, date ? null : paper.year].filter(Boolean).join(' · ') : '';
  const byline = [showAuthor ? item.author : null, site, date, time].filter(Boolean).join(' · ');
  const category = item.categoryId ? categories?.find((c) => c.id === item.categoryId) : undefined;
  const arxiv = paper?.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : null;
  const doi = paper?.doi ? `https://doi.org/${paper.doi}` : null;

  return (
    <header className={`article-header${tweet ? ' article-header-compact' : ''}`}>
      {/* A post's content starts with its author and date (extractor), so the header shows only the links. */}
      {tweet ? null : (
        <>
          <h1 className="article-title">{item.title || 'Untitled'}</h1>
          {authors.length ? (
            <p className="article-authors">
              {authors.slice(0, MAX_AUTHORS).join(', ')}
              {authors.length > MAX_AUTHORS ? ` +${authors.length - MAX_AUTHORS} more` : ''}
            </p>
          ) : null}
          {venue ? <p className="article-byline">{venue}</p> : null}
          {byline ? <p className="article-byline">{byline}</p> : null}
        </>
      )}

      <div className="article-links">
        {item.url ? (
          <ExtLink href={item.url} className="article-link">
            {tweet ? 'View post' : site || 'Original'} <External size={14} />
          </ExtLink>
        ) : item.file ? (
          <button type="button" className="article-link article-link-button" onClick={() => openOriginal(item)}>
            Open file <External size={14} />
          </button>
        ) : null}
        {paper?.pdfUrl ? (
          <ExtLink href={paper.pdfUrl} className="article-link">
            PDF <External size={14} />
          </ExtLink>
        ) : null}
        {arxiv && arxiv !== item.url ? (
          <ExtLink href={arxiv} className="article-link">
            arXiv:{paper!.arxivId}
          </ExtLink>
        ) : null}
        {doi && doi !== item.url ? (
          <ExtLink href={doi} className="article-link">
            DOI
          </ExtLink>
        ) : null}
      </div>

      <div className="article-chips">
        {category ? (
          <button type="button" className="chip" onClick={onEdit}>
            {category.name}
          </button>
        ) : null}
        {item.tags.map((t) => (
          <button key={t} type="button" className="chip" onClick={onEdit}>
            #{t}
          </button>
        ))}
        {!category && item.tags.length === 0 ? (
          <button type="button" className="chip article-chip-add" onClick={onEdit}>
            <Tag size={14} /> Add tags
          </button>
        ) : null}
      </div>

      {item.note ? (
        <button type="button" className="article-note" onClick={onEdit}>
          <span className="article-note-label">Note</span> {item.note}
        </button>
      ) : null}

      {children}
    </header>
  );
}
