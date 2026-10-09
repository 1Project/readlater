package app.readlater.reader;

import android.view.KeyEvent;
import java.io.File;
import java.util.Locale;

/** Pure helpers for share intents and hardware page keys (unit-tested, no Android runtime needed). */
final class SharedFiles {

    /** Same limit as the web upload (lib/data.ts MAX_UPLOAD_BYTES). */
    static final long MAX_BYTES = 100L * 1024 * 1024;

    /** Shared files older than this are removed from the cache directory. */
    static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;

    static final String MIME_PDF = "application/pdf";
    static final String MIME_EPUB = "application/epub+zip";

    private SharedFiles() {}

    /**
     * Page direction for a hardware key: +1 = next page, -1 = previous page, 0 = not a page key.
     * Volume down / page down turn forward (matches most e-readers).
     */
    static int pageDirection(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_VOLUME_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
                return 1;
            case KeyEvent.KEYCODE_VOLUME_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
                return -1;
            default:
                return 0;
        }
    }

    /** Resolve the effective MIME type of a shared document from the declared type and the file name. */
    static String resolveMime(String declared, String name) {
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".pdf")) return MIME_PDF;
        if (lower.endsWith(".epub")) return MIME_EPUB;
        if (MIME_PDF.equals(declared) || MIME_EPUB.equals(declared)) return declared;
        return null;
    }

    /**
     * A file-system safe display name that keeps the right extension, so the web upload
     * (which checks the extension and the blob type) recognises it.
     */
    static String safeName(String name, String mime) {
        String base = name == null ? "" : name.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^\\w.\\- ()\\[\\]]+", "_").replaceAll("^[.\\s]+", "");
        String ext = MIME_EPUB.equals(mime) ? ".epub" : ".pdf";
        if (base.isEmpty() || base.equals(ext)) base = (MIME_EPUB.equals(mime) ? "book" : "document") + ext;
        if (!base.toLowerCase(Locale.ROOT).endsWith(ext)) base = base + ext;
        if (base.length() > 120) base = base.substring(base.length() - 120);
        return base;
    }

    /** Delete stale files from a previous share (best effort). */
    static void pruneOld(File dir, long now) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (now - f.lastModified() > MAX_AGE_MS) {
                deleteRecursively(f);
            }
        }
    }

    private static void deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursively(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
