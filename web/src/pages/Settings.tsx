/**
 * /settings — one scrolling page with an in-page index. Sections live in ./settings/*.
 * Deep links: /settings#appearance, #reader, #categories, #tags, #link, #saving, #import, #export, #account.
 */
import { useEffect, type MouseEvent } from 'react';
import { useLocation } from 'react-router';
import { AccountSection, ExportSection } from './settings/DataSections';
import { AppearanceSection, ReaderSection } from './settings/AppearanceSection';
import { ImportSection } from './settings/ImportSection';
import { LinkDeviceSection } from './settings/LinkDeviceSection';
import { CategoriesSection, TagsSection } from './settings/OrganizeSections';
import { SavingSection } from './settings/SavingSection';
import './settings.css';

const INDEX = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'reader', label: 'Reader' },
  { id: 'categories', label: 'Categories' },
  { id: 'tags', label: 'Tags' },
  { id: 'link', label: 'Link a device' },
  { id: 'saving', label: 'Saving' },
  { id: 'import', label: 'Import' },
  { id: 'export', label: 'Export' },
  { id: 'account', label: 'Account' },
];

function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  const heading = el.querySelector<HTMLElement>('h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

export default function Settings() {
  const { hash } = useLocation();

  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (id) jump(id);
  }, [hash]);

  const onIndex = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    window.history.replaceState(window.history.state, '', `#${id}`);
    jump(id);
  };

  return (
    <main className="page settings-page">
      <h1 className="set-title">Settings</h1>
      <nav className="set-index" aria-label="Settings sections">
        <ul>
          {INDEX.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="chip set-index-link" onClick={(e) => onIndex(e, s.id)}>
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <AppearanceSection />
      <ReaderSection />
      <CategoriesSection />
      <TagsSection />
      <LinkDeviceSection />
      <SavingSection />
      <ImportSection />
      <ExportSection />
      <AccountSection />
    </main>
  );
}
