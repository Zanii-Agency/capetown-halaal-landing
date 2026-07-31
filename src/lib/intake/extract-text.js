// Local text extraction from binary documents. Free (no LLM).
//
// PDF  → unpdf
// DOCX → mammoth
// XLSX/CSV → SheetJS
// text/* + JSON → utf-8 decode
//
// These libraries are dynamic-imported so the Adapter only pays the
// install cost for the document types it actually receives. Returns
// clean text capped at maxChars, or null when the type has no text
// layer (images, scans, audio, video, postscript, etc.). Throws nothing.
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/**
 * Extract clean text from raw bytes in hand. Used by the ingest pipeline
 * so a PDF/Word/sheet is read into cheap TEXT locally instead of paying
 * for vision. Returns null when the type has no text layer.
 */
export async function extractTextFromBuffer(buf, mime, opts = {}) {
    const max = opts.maxChars ?? 200_000;
    try {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (mime === "application/pdf") {
            // @ts-expect-error — unpdf is a peer dep resolved from the consuming project's node_modules
            const { extractText, getDocumentProxy } = await import("unpdf");
            const pdf = await getDocumentProxy(new Uint8Array(b));
            const { text } = await extractText(pdf, { mergePages: true });
            return clean(Array.isArray(text) ? text.join("\n") : text, max);
        }
        if (mime === DOCX || mime === "application/msword") {
            // @ts-expect-error — mammoth is a peer dep
            const mod = await import("mammoth");
            const mammoth = mod.default || mod;
            const { value } = await mammoth.extractRawText({ buffer: b });
            return clean(value, max);
        }
        if (mime === XLSX_MIME || mime === "application/vnd.ms-excel") {
            // @ts-expect-error — xlsx is a peer dep
            const XLSX = await import("xlsx");
            const wb = XLSX.read(b, { type: "buffer" });
            const txt = wb.SheetNames.map((n) => `# ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n\n");
            return clean(txt, max);
        }
        if (mime.startsWith("text/") || mime === "application/json") {
            return clean(b.toString("utf8"), max);
        }
        return null;
    }
    catch {
        return null;
    }
}
function clean(s, max) {
    const t = (s || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return t.length > max ? t.slice(0, max) + "\n\n[…truncated]" : t;
}
//# sourceMappingURL=extract-text.js.map