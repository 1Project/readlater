package app.readlater.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;
import java.io.File;
import java.nio.file.Files;
import org.junit.Test;

public class SharedFilesTest {

    @Test
    public void pageDirection_mapsVolumeAndPageKeys() {
        assertEquals(1, SharedFiles.pageDirection(KeyEvent.KEYCODE_VOLUME_DOWN));
        assertEquals(1, SharedFiles.pageDirection(KeyEvent.KEYCODE_PAGE_DOWN));
        assertEquals(-1, SharedFiles.pageDirection(KeyEvent.KEYCODE_VOLUME_UP));
        assertEquals(-1, SharedFiles.pageDirection(KeyEvent.KEYCODE_PAGE_UP));
        assertEquals(0, SharedFiles.pageDirection(KeyEvent.KEYCODE_ENTER));
        assertEquals(0, SharedFiles.pageDirection(KeyEvent.KEYCODE_VOLUME_MUTE));
    }

    @Test
    public void resolveMime_prefersExtensionThenDeclaredType() {
        assertEquals(SharedFiles.MIME_PDF, SharedFiles.resolveMime("application/octet-stream", "Paper.PDF"));
        assertEquals(SharedFiles.MIME_EPUB, SharedFiles.resolveMime(null, "book.epub"));
        assertEquals(SharedFiles.MIME_EPUB, SharedFiles.resolveMime(SharedFiles.MIME_EPUB, "download"));
        assertEquals(SharedFiles.MIME_PDF, SharedFiles.resolveMime(SharedFiles.MIME_PDF, null));
        assertNull(SharedFiles.resolveMime("image/png", "photo.png"));
        assertNull(SharedFiles.resolveMime(null, null));
    }

    @Test
    public void safeName_keepsExtensionAndStripsPaths() {
        assertEquals("report.pdf", SharedFiles.safeName("report.pdf", SharedFiles.MIME_PDF));
        assertEquals("report.pdf", SharedFiles.safeName("/sdcard/Download/report.pdf", SharedFiles.MIME_PDF));
        assertEquals("download.epub", SharedFiles.safeName("download", SharedFiles.MIME_EPUB));
        assertEquals("document.pdf", SharedFiles.safeName(null, SharedFiles.MIME_PDF));
        assertEquals("book.epub", SharedFiles.safeName("..", SharedFiles.MIME_EPUB));
        assertEquals("a_b.pdf", SharedFiles.safeName("a:b.pdf", SharedFiles.MIME_PDF));
        String longName = new String(new char[300]).replace('\0', 'x') + ".pdf";
        String safe = SharedFiles.safeName(longName, SharedFiles.MIME_PDF);
        assertEquals(120, safe.length());
        assertTrue(safe.endsWith(".pdf"));
    }

    @Test
    public void pruneOld_removesOnlyStaleEntries() throws Exception {
        File dir = Files.createTempDirectory("shared").toFile();
        File fresh = new File(dir, "fresh");
        File stale = new File(dir, "stale");
        assertTrue(fresh.mkdir());
        assertTrue(stale.mkdir());
        File inner = new File(stale, "old.pdf");
        assertTrue(inner.createNewFile());
        long now = System.currentTimeMillis();
        assertTrue(stale.setLastModified(now - SharedFiles.MAX_AGE_MS - 1000));
        SharedFiles.pruneOld(dir, now);
        assertTrue(fresh.exists());
        assertFalse(stale.exists());
    }

    @Test
    public void isAllowedSource_onlyContentUrisOfOtherApps() {
        String own = "app.readlater.reader";
        assertTrue(SharedFiles.isAllowedSource("content", "com.android.providers.downloads.documents", own));
        assertTrue(SharedFiles.isAllowedSource("content", "app.readlaterx.provider", own));
        assertFalse(SharedFiles.isAllowedSource("file", null, own));
        assertFalse(SharedFiles.isAllowedSource("file", "", own));
        assertFalse(SharedFiles.isAllowedSource("content", "app.readlater.reader.fileprovider", own));
        assertFalse(SharedFiles.isAllowedSource("content", "APP.READLATER.READER", own));
        assertFalse(SharedFiles.isAllowedSource("content", null, own));
        assertFalse(SharedFiles.isAllowedSource("https", "example.com", own));
    }

    @Test
    public void looksLike_checksTheBytes() {
        byte[] pdf = "%PDF-1.7\n...".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
        assertTrue(SharedFiles.looksLike(pdf, pdf.length, SharedFiles.MIME_PDF));
        assertFalse(SharedFiles.looksLike(pdf, pdf.length, SharedFiles.MIME_EPUB));
        byte[] sqlite = "SQLite format 3\u0000".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
        assertFalse(SharedFiles.looksLike(sqlite, sqlite.length, SharedFiles.MIME_PDF));

        byte[] epub = new byte[30 + 28];
        epub[0] = 'P';
        epub[1] = 'K';
        epub[2] = 3;
        epub[3] = 4;
        byte[] name = "mimetypeapplication/epub+zip".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
        System.arraycopy(name, 0, epub, 30, name.length);
        assertTrue(SharedFiles.looksLike(epub, epub.length, SharedFiles.MIME_EPUB));
        epub[3] = 5;
        assertFalse(SharedFiles.looksLike(epub, epub.length, SharedFiles.MIME_EPUB));
        assertFalse(SharedFiles.looksLike(null, 0, SharedFiles.MIME_PDF));
    }
}
