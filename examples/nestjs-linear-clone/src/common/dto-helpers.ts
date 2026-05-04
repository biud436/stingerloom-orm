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
 *   - `applyPatch(target, patch, transforms?)`
 *     — mutate `target` with the keys from `patch`, optionally running each
 *       value through a per-key transformer first (e.g. `JSON.stringify` for
 *       JSON columns).
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

export type Transformer<T, K extends keyof T = keyof T> = (
  value: NonNullable<T[K]>,
) => unknown;

export type Transformers<T> = {
  [K in keyof T]?: Transformer<T, K>;
};

/**
 * Mutate `target` with values from `patch`, applying per-key transformers
 * before assignment. Keys whose source value is `undefined` are left
 * untouched on `target`.
 *
 * @example
 *   applyPatch(issue, dto, { customFields: JSON.stringify });
 */
export function applyPatch<T extends object, P extends Partial<T>>(
  target: T,
  patch: P,
  transforms?: Transformers<T>,
): T {
  for (const k in patch) {
    const value = patch[k];
    if (value === undefined) continue;
    const transform = transforms?.[k as unknown as keyof T];
    (target as any)[k] = transform
      ? transform(value as NonNullable<T[keyof T]>)
      : value;
  }
  return target;
}
