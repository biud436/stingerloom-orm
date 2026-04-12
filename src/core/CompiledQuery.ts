/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "sql-template-tag";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

const PLACEHOLDER_SYMBOL = Symbol.for("stingerloom.placeholder");

/**
 * Sentinel object that marks a parameter slot in a compiled query.
 *
 * At compile time, placeholders are embedded in the `Sql.values[]` array
 * in place of concrete values. At execute time, the `CompiledQuery`
 * substitutes them with values supplied by the caller.
 */
export class PlaceholderMarker {
  public readonly [PLACEHOLDER_SYMBOL] = true as const;
  // String index signature makes instances assignable to
  // `Record<string, unknown>` — the value shape expected by
  // `sql-template-tag` interpolations — without casts at call sites.
  readonly [key: string]: unknown;
  constructor(public readonly name: string) {}
}

/**
 * Create a parameter placeholder for use with `qb.prepare()` / `em.compile()`.
 *
 * @example
 * ```ts
 * const q = em.createQueryBuilder(User, "u")
 *   .where("u.id = :id", { id: p("id") })
 *   .prepare<{ id: number }>();
 *
 * await q.executeOne({ id: 42 });
 * await q.executeOne({ id: 77 });   // SQL is not re-built
 * ```
 */
export function p(name: string): PlaceholderMarker {
  return new PlaceholderMarker(name);
}

/** Type guard for `PlaceholderMarker`. */
export function isPlaceholder(value: unknown): value is PlaceholderMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any)[PLACEHOLDER_SYMBOL] === true
  );
}

/**
 * A pre-compiled query whose SQL was built once and can be executed
 * repeatedly with different parameter values. Eliminates the cost of
 * rebuilding the `Sql` object on every call.
 *
 * Obtained via `SelectQueryBuilder.prepare()`, `RawQueryBuilder.prepare()`,
 * or `EntityManager.compile()`.
 *
 * @typeParam T - The result row type.
 * @typeParam P - The parameter object type (keys are placeholder names).
 */
export class CompiledQuery<
  T,
  P extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly placeholderNames: ReadonlyArray<string>;

  /**
   * @internal
   * @param strings - Flattened literal chunks from the compiled `Sql`.
   * @param valueSlots - Flattened values, where `PlaceholderMarker`
   *                     instances mark runtime parameter slots.
   * @param executor - Dispatches the final `Sql` through the ORM
   *                   (typically `em.query`).
   * @param deserialize - Optional transform from raw rows to `T[]`.
   */
  constructor(
    private readonly strings: ReadonlyArray<string>,
    private readonly valueSlots: ReadonlyArray<unknown>,
    private readonly executor: (sql: Sql) => Promise<any[]>,
    private readonly deserialize?: (rows: any[]) => T[],
  ) {
    const names = new Set<string>();
    for (const slot of valueSlots) {
      if (isPlaceholder(slot)) names.add(slot.name);
    }
    this.placeholderNames = Array.from(names);
  }

  /** Names of all placeholders required by this query. */
  get parameterNames(): ReadonlyArray<string> {
    return this.placeholderNames;
  }

  /** Returns the compiled SQL text (driver-agnostic, uses `?` placeholders). */
  get sql(): string {
    return this.strings.join("?");
  }

  /**
   * Execute the compiled query and return the typed result array.
   */
  async execute(params: P = {} as P): Promise<T[]> {
    const resolved = this.resolveValues(params);
    const finalSql = new Sql(
      this.strings as string[],
      resolved as any[],
    );
    const rows = await this.executor(finalSql);
    return this.deserialize ? this.deserialize(rows) : (rows as T[]);
  }

  /**
   * Execute and return the first result, or `null` if no rows matched.
   * Assumes the compiled query already includes `LIMIT 1` if desired.
   */
  async executeOne(params: P = {} as P): Promise<T | null> {
    const rows = await this.execute(params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Execute and return raw rows without running the deserializer.
   */
  async executeRaw(params: P = {} as P): Promise<unknown[]> {
    const resolved = this.resolveValues(params);
    const finalSql = new Sql(
      this.strings as string[],
      resolved as any[],
    );
    return this.executor(finalSql);
  }

  private resolveValues(params: P): unknown[] {
    const out = new Array<unknown>(this.valueSlots.length);
    for (let i = 0; i < this.valueSlots.length; i++) {
      const slot = this.valueSlots[i];
      if (isPlaceholder(slot)) {
        if (!Object.prototype.hasOwnProperty.call(params, slot.name)) {
          throw new OrmError(
            OrmErrorCode.MISSING_PLACEHOLDER,
            `Missing value for placeholder "${slot.name}" in compiled query.`,
            `Pass { ${slot.name}: ... } to execute() / executeOne().`,
          );
        }
        out[i] = (params as Record<string, unknown>)[slot.name];
      } else {
        out[i] = slot;
      }
    }
    return out;
  }
}
