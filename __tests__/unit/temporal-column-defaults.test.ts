/**
 * defaultTemporalColumnRead / isTemporalColumnType (V3-T1-1).
 *
 * The default read conversion for datetime/timestamp/timestamptz/date
 * columns must invert exactly the formats the ORM writes to SQLite —
 * Date.prototype.toISOString() and formatDateTimeForSQL()'s local
 * "YYYY-MM-DD HH:MM:SS" — plus bare "YYYY-MM-DD", and must never corrupt
 * values it cannot parse.
 */
import {
  defaultTemporalColumnRead,
  isTemporalColumnType,
} from "../../src/core/TemporalColumnTransformer";

describe("isTemporalColumnType", () => {
  it("accepts the four temporal column types", () => {
    expect(isTemporalColumnType("datetime")).toBe(true);
    expect(isTemporalColumnType("timestamp")).toBe(true);
    expect(isTemporalColumnType("timestamptz")).toBe(true);
    expect(isTemporalColumnType("date")).toBe(true);
  });

  it("rejects non-temporal types and empty input", () => {
    expect(isTemporalColumnType("varchar")).toBe(false);
    expect(isTemporalColumnType("int")).toBe(false);
    expect(isTemporalColumnType("json")).toBe(false);
    expect(isTemporalColumnType(undefined)).toBe(false);
    expect(isTemporalColumnType(null)).toBe(false);
    expect(isTemporalColumnType("")).toBe(false);
  });
});

describe("defaultTemporalColumnRead", () => {
  it("passes Date instances through unchanged (pg/mysql2 driver output)", () => {
    const d = new Date("2026-08-05T13:06:11.123Z");
    expect(defaultTemporalColumnRead(d)).toBe(d);
  });

  it("parses toISOString() output back to the exact instant (ms precision)", () => {
    const original = new Date("2026-08-05T13:06:11.123Z");
    const parsed = defaultTemporalColumnRead(original.toISOString());
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).getTime()).toBe(original.getTime());
  });

  it('parses local "YYYY-MM-DD HH:MM:SS" as local wall time (formatDateTimeForSQL inverse)', () => {
    const parsed = defaultTemporalColumnRead("2026-08-05 22:06:11");
    expect(parsed).toBeInstanceOf(Date);
    const d = parsed as Date;
    expect([
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
    ]).toEqual([2026, 8, 5, 22, 6, 11, 0]);
  });

  it("parses zone-less T-separated datetimes as local time (ISO 8601 semantics)", () => {
    const parsed = defaultTemporalColumnRead("2026-08-05T22:06:11.123") as Date;
    expect([
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate(),
      parsed.getHours(),
      parsed.getMilliseconds(),
    ]).toEqual([2026, 8, 5, 22, 123]);
  });

  it("truncates sub-millisecond fractions instead of misreading them", () => {
    const parsed = defaultTemporalColumnRead("2026-08-05 22:06:11.123456") as Date;
    expect(parsed.getMilliseconds()).toBe(123);
    const short = defaultTemporalColumnRead("2026-08-05 22:06:11.5") as Date;
    expect(short.getMilliseconds()).toBe(500);
  });

  it('parses bare "YYYY-MM-DD" to LOCAL midnight — no calendar-day shift', () => {
    const parsed = defaultTemporalColumnRead("2026-08-05") as Date;
    expect([
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate(),
      parsed.getHours(),
      parsed.getMinutes(),
      parsed.getSeconds(),
    ]).toEqual([2026, 8, 5, 0, 0, 0]);
  });

  it('parses second-precision UTC strings ("...SSZ", no fraction) as UTC', () => {
    const parsed = defaultTemporalColumnRead("2026-08-05T13:06:11Z") as Date;
    expect(parsed.getTime()).toBe(Date.UTC(2026, 7, 5, 13, 6, 11));
  });

  it("falls back safely on structural near-misses of the ORM formats", () => {
    // Correct date prefix, bogus separator → not silently mis-parsed.
    expect(defaultTemporalColumnRead("2026-08-05x22:06:11")).toBe(
      "2026-08-05x22:06:11",
    );
    // Dot with no fraction digits → V8 rejects → raw passthrough.
    expect(defaultTemporalColumnRead("2026-08-05 22:06:11.")).toBe(
      "2026-08-05 22:06:11.",
    );
  });

  it("parses explicit-offset strings via the Date constructor", () => {
    const parsed = defaultTemporalColumnRead("2026-08-05T22:06:11+09:00") as Date;
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.getTime()).toBe(new Date("2026-08-05T13:06:11Z").getTime());
  });

  it("returns unparseable strings unchanged (never an Invalid Date)", () => {
    expect(defaultTemporalColumnRead("not-a-date")).toBe("not-a-date");
    expect(defaultTemporalColumnRead("")).toBe("");
  });

  it("passes non-string, non-Date values through (epoch integers, null, undefined)", () => {
    expect(defaultTemporalColumnRead(1754398800000)).toBe(1754398800000);
    expect(defaultTemporalColumnRead(null)).toBeNull();
    expect(defaultTemporalColumnRead(undefined)).toBeUndefined();
    const buf = Buffer.from("x");
    expect(defaultTemporalColumnRead(buf)).toBe(buf);
  });
});
