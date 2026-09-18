import { extractSnippet, addLineNumbers } from "./store.js";

/** Hide index frontmatter without changing any source character/line offsets. */
export function scopedDocumentSnippet(body: string, query: string, chunkPos?: number, chunkLen?: number) {
  const prose = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, header => header.replace(/[^\r\n]/g, " "));
  const selected = extractSnippet(prose, query, 300, chunkPos, chunkLen);
  // extractSnippet.line points to the match, not the beginning of its context.
  // Its diff header is synthetic and must not consume a source line number.
  const content = selected.snippet.replace(/^@@[^\n]*\n/, "");
  return { line: selected.line, snippet: addLineNumbers(content, selected.linesBefore + 1) };
}
