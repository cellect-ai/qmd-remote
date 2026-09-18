const NOISE = new Set("i a an the need want find show get give me my please document documents file files for from of in on at to and or with whose someone's someone".split(" "));
function tokens(value: string): Set<string> {
  return new Set(value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2 && !NOISE.has(t)) ?? []);
}

/** Relative lexical identity evidence, never a substitute for ACL filtering. */
export function identityCoverage(query: string, identities: string[]): number[] {
  const terms = [...tokens(query)];
  const rows = identities.map(tokens);
  const weights = terms.map(term => Math.log(1 + (rows.length + 1) / (1 + rows.filter(row => row.has(term)).length)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return rows.map(() => 0);
  return rows.map(row => terms.reduce((score, term, i) => score + (row.has(term) ? weights[i]! : 0), 0) / total);
}

export function documentIdentity(title: string, body: string, metadata: unknown): string {
  // Rooms frontmatter title retains the source filename, unlike OCR headings.
  const sourceTitle = body.match(/^title:\s*(.+)$/m)?.[1] ?? "";
  return `${title} ${sourceTitle} ${JSON.stringify(metadata ?? {})}`;
}

/** Prefer the requested document kind over correspondence mentioning it.
 * This is a small ordering signal, not a status filter: a void agreement must
 * remain findable, and asking for its void confirmation should favor that type.
 */
export function documentTypeBoost(query: string, metadata: unknown): number {
  if (!metadata || typeof metadata !== "object" || !("type" in metadata)
    || typeof metadata.type !== "string") return 0;
  const kind = [...tokens(metadata.type)];
  const requested = [...tokens(query)];
  const qualifiers = ["void", "termination", "cancellation", "amendment", "addendum"];
  const explicit = qualifiers.filter(term => requested.includes(term));
  if (explicit.length) return explicit.every(term => kind.includes(term)) ? 0.1 : 0;
  return kind.length > 0 && kind.every(term => requested.includes(term)) ? 0.1 : 0;
}
