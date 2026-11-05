export interface ChunkOptions { chunkSize: number; chunkOverlap: number }

/**
 * Recursive character splitter: tries paragraphs, then lines, then sentences, then words,
 * so chunks end on natural boundaries whenever possible. Sizes are in characters.
 */
export function chunkText(text: string, opts: ChunkOptions): Array<{ text: string; start: number }> {
  const size = Math.max(50, opts.chunkSize);
  const overlap = Math.min(opts.chunkOverlap, Math.floor(size / 2));
  const separators = ["\n\n", "\n", /(?<=[.!?])\s+/, " "];
  const pieces = split(text, separators, size);
  const out: Array<{ text: string; start: number }> = [];
  let buf = "", bufStart = 0, pos = 0;
  const flush = () => { if (buf.trim()) out.push({ text: buf.trim(), start: bufStart }); };
  for (const piece of pieces) {
    if (buf.length + piece.length > size && buf) {
      flush();
      const keep = buf.slice(Math.max(0, buf.length - overlap));
      bufStart = pos - keep.length;
      buf = keep;
    }
    if (!buf) bufStart = pos;
    buf += piece;
    pos += piece.length;
  }
  flush();
  return out;
}

function split(text: string, seps: Array<string | RegExp>, size: number): string[] {
  if (text.length <= size || !seps.length) return text.length <= size ? [text] : hardSplit(text, size);
  const [sep, ...rest] = seps as [string | RegExp, ...Array<string | RegExp>];
  const parts: string[] = [];
  if (typeof sep === "string") {
    const raw = text.split(sep);
    raw.forEach((p, i) => parts.push(i < raw.length - 1 ? p + sep : p));
  } else {
    let last = 0;
    for (const m of text.matchAll(new RegExp(sep.source, sep.flags.includes("g") ? sep.flags : sep.flags + "g"))) {
      const end = (m.index ?? 0) + m[0].length;
      parts.push(text.slice(last, end));
      last = end;
    }
    if (last < text.length) parts.push(text.slice(last));
  }
  return parts.flatMap((p) => (p.length > size ? split(p, rest, size) : [p]));
}

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Strip HTML to readable text (good enough for docs pages). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}
