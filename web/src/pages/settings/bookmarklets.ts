/**
 * Bookmarklet code (Settings › Bookmarklets, docs/SPEC-2.md §1).
 *
 * Exports:
 *   javascriptUrl(code): string            `javascript:` URL with the code percent-encoded, so it survives being
 *                                          dragged to the bookmarks bar or pasted as a bookmark address
 *                                          (browsers percent-decode a javascript: URL before running it)
 *   saveBookmarkletCode(base, key): string "Save to Readlater": opens a small window on GET /api/save, which saves
 *                                          with the API key and closes itself; works on CSP-strict pages
 *   openBookmarkletCode(base): string      "Open in Readlater": /add?url=… in the signed-in web app (no key)
 */

const READABLE = /%(2C|2F|3A|3B|3D|2B|40|26|24)/g; // , / : ; = + @ & $ — safe to leave unescaped

export function javascriptUrl(code: string): string {
  return `javascript:${encodeURIComponent(code).replace(READABLE, (m) => decodeURIComponent(m))}`;
}

export function saveBookmarkletCode(base: string, key: string): string {
  const prefix = `${base}/api/save?key=${encodeURIComponent(key)}&source=bookmarklet&url=`;
  return (
    `window.open(${JSON.stringify(prefix)}+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),` +
    `'rl','width=420,height=260');void 0`
  );
}

export function openBookmarkletCode(base: string): string {
  return (
    `(function(){var u=${JSON.stringify(`${base}/add?url=`)}+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+'&source=bookmarklet';` +
    `var w=window.open(u,'_blank');if(!w)location.href=u;})()`
  );
}
