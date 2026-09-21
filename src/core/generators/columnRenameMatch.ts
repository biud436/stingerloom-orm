/**
 * Deciding whether a dropped column and an added column are the same column
 * under a new name.
 *
 * The diff cannot know: a column swap (`legacyNote` removed, `bio` added) and
 * a rename produce the identical add/drop pair. Guessing wrong is not a
 * cosmetic mistake — a wrong RENAME leaves the old rows' data under the new
 * name, which is how a dropped `legacyNote` ends up being served as someone's
 * `bio`. So a rename is only executed when the entity says so
 * (`@Column({ renamedFrom })`) or when the two names are close enough that no
 * other reading is plausible; everything else is reported and left as the
 * drop + add the entity literally declares.
 */

/** Minimum normalized similarity for two names to read as the same column. */
export const RENAME_SIMILARITY_THRESHOLD = 0.7;

/** Shortest prefix/suffix that may stand in for a whole name (`name` → `fullName`). */
const MIN_CONTAINMENT_LENGTH = 3;

/**
 * Lowercases and removes the separators a naming strategy switch changes, so
 * `userName`, `user_name` and `USERNAME` all normalize to the same string.
 */
export function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, "");
}

/** Levenshtein distance (iterative, two rows). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Similarity of two column names in 0..1, computed on their normalized form.
 * 1 means "the same name modulo case and separators".
 */
export function columnNameSimilarity(a: string, b: string): number {
  const na = normalizeColumnName(a);
  const nb = normalizeColumnName(b);
  if (na === nb) return 1;
  const longest = Math.max(na.length, nb.length);
  if (longest === 0) return 1;
  return 1 - editDistance(na, nb) / longest;
}

/**
 * Whether two names are close enough to read as one column renamed.
 *
 * True for a separator/case change (`user_name` → `userName`), for a name that
 * grew or lost a qualifier (`name` → `fullName`, `legacyNote` → `note`), and
 * for a small edit such as a typo fix. False for names that merely share a
 * type (`legacyNote` → `bio`, `createdAt` → `updatedAt`).
 */
export function columnNamesLookRenamed(a: string, b: string): boolean {
  const na = normalizeColumnName(a);
  const nb = normalizeColumnName(b);
  if (na === nb) return true;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= MIN_CONTAINMENT_LENGTH && longer.includes(shorter)) {
    return true;
  }

  return columnNameSimilarity(a, b) >= RENAME_SIMILARITY_THRESHOLD;
}
