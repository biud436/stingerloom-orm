/** Column types whose values hydrate to a JS Date. */
const TEMPORAL_COLUMN_TYPES = new Set([
  "datetime",
  "timestamp",
  "timestamptz",
  "date",
]);

export function isTemporalColumnType(type: string | undefined | null): boolean {
  return !!type && TEMPORAL_COLUMN_TYPES.has(type);
}

/**
 * Default read-side transform for temporal columns
 * (`datetime` / `timestamp` / `timestamptz` / `date`).
 *
 * pg and mysql2 parse temporal columns into Date at the driver, but
 * better-sqlite3 has no column type information and returns the stored TEXT
 * as-is — so without this, the same entity property is a Date on
 * PostgreSQL/MySQL and a string on SQLite. The declared column type drives
 * the conversion instead, inverting the exact formats the ORM writes:
 *
 * - Date → pass through (pg / mysql2 driver output)
 * - "YYYY-MM-DD HH:MM:SS[.fff]" (no zone) → local wall time, the inverse of
 *   formatDateTimeForSQL(); "T"-separated zone-less strings are local per
 *   ISO 8601 semantics as well
 * - "YYYY-MM-DDTHH:MM:SS[.fff]Z" → UTC (Date.prototype.toISOString(), the
 *   driver-bound Date format)
 * - "YYYY-MM-DD" → LOCAL midnight (pg / mysql2 DATE convention — parsing via
 *   `new Date()` would yield UTC midnight and shift a calendar day in
 *   negative-offset timezones)
 * - other strings (explicit offsets, exotic formats) → `new Date()`;
 *   unparseable strings pass through unchanged rather than corrupting to an
 *   Invalid Date
 * - numbers and everything else → pass through (epoch integers are a user
 *   convention the ORM cannot disambiguate — seconds vs ms; use a
 *   `@Column({ transformer })` for those)
 *
 * This runs once per temporal value on every hydrated row, so the two ORM
 * formats are decoded with positional charCode parsing instead of a regex —
 * regex capture extraction costs ~4x the Date construction itself.
 */
export function defaultTemporalColumnRead(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return value;
  return parseTemporalString(value) ?? value;
}

const CH_MINUS = 45;
const CH_DOT = 46;
const CH_COLON = 58;
const CH_SPACE = 32;
const CH_T = 84;
const CH_Z = 90;

/** Parses "NN" at position `i`; returns -1 unless both chars are digits. */
function twoDigits(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48;
  const b = s.charCodeAt(i + 1) - 48;
  if (a < 0 || a > 9 || b < 0 || b > 9) return -1;
  return a * 10 + b;
}

function fallbackParse(s: string): Date | null {
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTemporalString(s: string): Date | null {
  const len = s.length;
  if (len < 10) return fallbackParse(s);

  // "YYYY-MM-DD" prefix
  const yh = twoDigits(s, 0);
  const yl = twoDigits(s, 2);
  if (
    yh < 0 ||
    yl < 0 ||
    s.charCodeAt(4) !== CH_MINUS ||
    s.charCodeAt(7) !== CH_MINUS
  ) {
    return fallbackParse(s);
  }
  const mo = twoDigits(s, 5);
  const d = twoDigits(s, 8);
  if (mo < 0 || d < 0) return fallbackParse(s);
  const y = yh * 100 + yl;

  // Bare date → LOCAL midnight (never UTC — that shifts a calendar day
  // for negative-offset timezones).
  if (len === 10) return new Date(y, mo - 1, d);

  const sep = s.charCodeAt(10);
  if ((sep !== CH_SPACE && sep !== CH_T) || len < 19) return fallbackParse(s);

  // "HH:MM:SS"
  const h = twoDigits(s, 11);
  const mi = twoDigits(s, 14);
  const se = twoDigits(s, 17);
  if (
    h < 0 ||
    mi < 0 ||
    se < 0 ||
    s.charCodeAt(13) !== CH_COLON ||
    s.charCodeAt(16) !== CH_COLON
  ) {
    return fallbackParse(s);
  }

  // Zone-less seconds precision → local wall time (formatDateTimeForSQL).
  if (len === 19) return new Date(y, mo - 1, d, h, mi, se);

  // Optional fractional seconds: keep ms precision, swallow extra digits.
  let i = 19;
  let ms = 0;
  if (s.charCodeAt(19) === CH_DOT) {
    let scale = 100;
    let digits = 0;
    i = 20;
    while (i < len) {
      const code = s.charCodeAt(i) - 48;
      if (code < 0 || code > 9) break;
      if (digits < 3) {
        ms += code * scale;
        scale /= 10;
      }
      digits++;
      i++;
    }
    if (digits === 0) return fallbackParse(s);
  }

  // Zone-less (possibly fractional) → local wall time.
  if (i === len) return new Date(y, mo - 1, d, h, mi, se, ms);

  // Trailing "Z" → UTC (Date.prototype.toISOString()).
  if (i === len - 1 && s.charCodeAt(i) === CH_Z) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms));
  }

  // Explicit offsets and anything else → the Date constructor.
  return fallbackParse(s);
}
