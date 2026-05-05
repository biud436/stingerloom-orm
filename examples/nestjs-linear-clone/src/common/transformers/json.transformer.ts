/**
 * Stingerloom column-transformer for JSON-shaped columns. Centralizes the
 * MySQL-vs-PostgreSQL asymmetry in one place:
 *
 *   - PostgreSQL `json`/`jsonb` returns parsed objects from `pg`.
 *   - MySQL/MariaDB returns the column as a string and expects strings on
 *     insert (the driver does not auto-stringify objects).
 *
 * Use on `@Column({ type: "json", transformer: jsonColumn<MyType>() })`. The
 * `to`/`from` shape matches Stingerloom's `ColumnTransformer<T>` interface.
 */
export interface ColumnTransformer<T> {
  to(value: T | null | undefined): unknown;
  from(value: unknown): T | null;
}

export function jsonColumn<T = Record<string, unknown>>(): ColumnTransformer<T> {
  return {
    to(value) {
      if (value === null || value === undefined) return null;
      // Already serialized (e.g. caller passed a raw string from a foreign source).
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    },
    from(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === "string") {
        if (value.length === 0) return null;
        try {
          return JSON.parse(value) as T;
        } catch {
          // Some drivers return the literal string `null` for absent JSON.
          return null;
        }
      }
      // pg returns a parsed object/array directly.
      return value as T;
    },
  };
}
