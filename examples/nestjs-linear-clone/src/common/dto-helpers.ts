/**
 * DTO → entity patch helpers.
 *
 * Replaces the verbose `if (dto.field !== undefined) entity.field = dto.field`
 * chain that any partial-update service ends up writing.
 *
 * Two helpers:
 *   - `pickDefined(obj, keys?)`  — return a new object containing only the
 *                                   keys whose value isn't `undefined`.
 *                                   When `keys` is omitted every own enumerable
 *                                   key on `obj` is considered.
 *   - `applyPatch(target, patch)` — mutate `target` with the keys from `patch`,
 *                                   skipping `undefined` values.
 *
 * JSON columns no longer need a per-key transformer here: a column declared
 * `@Column({ type: "json" | "jsonb" })` auto-serializes plain objects on write
 * and parses them back on read, so service code assigns
 * `entity.customFields = { ... }` directly — no `JSON.stringify` plumbing.
 */

export function pickDefined<T extends object>(
  obj: T,
  keys?: ReadonlyArray<keyof T>,
): Partial<T> {
  const out: Partial<T> = {};
  const list = (keys ?? (Object.keys(obj) as Array<keyof T>)) as Array<keyof T>;
  for (const k of list) {
    const v = obj[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Mutate `target` with values from `patch`. Keys whose source value is
 * `undefined` are left untouched on `target`.
 *
 * @example
 *   applyPatch(issue, pickDefined(dto, PATCHABLE_KEYS));
 */
export function applyPatch<T extends object, P extends Partial<T>>(
  target: T,
  patch: P,
): T {
  for (const k in patch) {
    const value = patch[k];
    if (value === undefined) continue;
    (target as any)[k] = value;
  }
  return target;
}
