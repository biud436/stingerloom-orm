/** Levenshtein distance between two short identifiers. */
function editDistance(a: string, b: string): number {
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[cols - 1];
}

/**
 * Closest candidate to `name` within a typo-sized distance, or null when
 * nothing is near enough — a wrong guess reads worse than no guess.
 *
 * Used by the query-time identifier guards ("Did you mean ...?") for relation
 * names and column names alike.
 */
export function closestIdentifier(
  name: string,
  candidates: Iterable<string>,
): string | null {
  const lowered = name.toLowerCase();
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    // A case-only mismatch is always the intended identifier.
    if (candidate.toLowerCase() === lowered) return candidate;
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const threshold = Math.max(1, Math.floor(name.length / 3));
  return best !== null && bestDistance <= threshold ? best : null;
}
