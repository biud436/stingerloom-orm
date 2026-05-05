/**
 * Extract `@handle` mentions from a markdown / plain-text body. A handle is
 * `[A-Za-z0-9_-]{1,32}` and the `@` must NOT be preceded by a word char or
 * another `@` — that filters out email addresses (`someone@example.com`) and
 * stylised double-`@` strings (`@@notamention`). Results are deduped while
 * preserving first-seen order.
 */
export function extractMentions(text: string): string[] {
  if (!text) return [];
  const regex = /(?:^|[^a-zA-Z0-9_@])@([a-zA-Z0-9_-]{1,32})\b/g;
  const out = new Set<string>();
  for (const m of text.matchAll(regex)) out.add(m[1]);
  return [...out];
}
