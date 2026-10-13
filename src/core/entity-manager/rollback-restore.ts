import type { TransactionSessionManager } from "../../dialects/TransactionSessionManager";

/** A property a write changed on one of the caller's objects. */
interface ChangedProperty {
  key: string;
  /** Whether the object had the property before the write. */
  had: boolean;
  before: unknown;
  /** The value the write left. */
  after: unknown;
}

function changesSince(
  target: Record<string, unknown>,
  before: Map<string, unknown>,
): ChangedProperty[] {
  const changes: ChangedProperty[] = [];
  for (const [key, after] of Object.entries(target)) {
    const had = before.has(key);
    if (had && Object.is(before.get(key), after)) continue;
    // An accessor's value follows the data properties it reads, which are
    // restored themselves.
    if (Object.getOwnPropertyDescriptor(target, key)?.get) continue;
    changes.push({ key, had, before: before.get(key), after });
  }
  return changes;
}

function undo(target: Record<string, unknown>, changes: ChangedProperty[]): void {
  for (const { key, had, before, after } of changes) {
    // Changed again since the write: the caller's value wins.
    if (!Object.is(target[key], after)) continue;
    if (had) target[key] = before;
    else delete target[key];
  }
}

/**
 * Runs `write`, a write that changes the caller's `targets` in place — the
 * generated key, the tenant column, a cascade's foreign key, the timestamps
 * and `@Version` seed a bulk insert stamps, and anything a hook sets — and
 * arranges for those properties to be put back if `session`'s transaction,
 * or a savepoint taken before the write, rolls back.
 *
 * Without it a rolled-back insert left the object holding a key no row has:
 * saving it again ran an UPDATE that matched nothing (or, on SQLite, a row
 * that later reused the key), and `@Version` / tenant values failed the
 * retry the same way.
 *
 * Only the object's own enumerable properties are compared, shallowly; a
 * related object is restored by its own write. A property the caller changes
 * after the write keeps the caller's value.
 */
export async function restoreOnRollback<R>(
  session: TransactionSessionManager | undefined,
  targets: readonly unknown[],
  write: () => Promise<R>,
): Promise<R> {
  if (!session?.isTransactionActive) return write();

  const objects = targets.filter(
    (target): target is Record<string, unknown> =>
      !!target && typeof target === "object",
  );
  const before = objects.map((target) => new Map(Object.entries(target)));
  try {
    return await write();
  } finally {
    objects.forEach((target, i) => {
      const changes = changesSince(target, before[i]);
      if (changes.length > 0) session.onRollback(() => undo(target, changes));
    });
  }
}
