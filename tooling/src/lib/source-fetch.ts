// source-fetch.ts — fetch raw text for a cited source, cached by source id.

const cache = new Map<string, string>(); // source id → fetched text

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function fetchSourceText(
  sourceId: string,
  source: { kind: string; url: string; revid?: number },
): Promise<string> {
  if (cache.has(sourceId)) return cache.get(sourceId)!;

  if (source.kind === "interpretive") {
    throw new Error(`fetchSourceText: interpretive sources are not supported (${sourceId})`);
  }

  let text: string;

  if (source.kind === "wikipedia") {
    if (!source.revid) throw new Error(`fetchSourceText: wikipedia source missing revid (${sourceId})`);
    const url = `https://en.wikipedia.org/w/index.php?oldid=${source.revid}&action=raw`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetchSourceText: HTTP ${res.status} for ${url}`);
    text = await res.text();
  } else {
    // official and any other kind: fetch HTML and strip tags
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`fetchSourceText: HTTP ${res.status} for ${source.url}`);
    const html = await res.text();
    text = stripTags(html);
  }

  cache.set(sourceId, text);
  return text;
}
