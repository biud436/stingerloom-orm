/**
 * Unit coverage for the write-payload key check (V5-T1-1): the pure
 * collector in ColumnNameValidator and the `unknownWriteKeys` option guard.
 * The policy behavior on the real write paths is pinned by
 * `__tests__/integration/sqlite/write-input-unknown-keys.test.ts`.
 */
import "reflect-metadata";
import {
  collectUnknownWriteKeys,
  ColumnNameScope,
} from "../../src/core/ColumnNameValidator";
import {
  DatabaseClientOptions,
  UNKNOWN_WRITE_KEY_POLICIES,
  validateDatabaseClientOptions,
} from "../../src/core/DatabaseClientOptions";
import { Logger } from "../../src/utils/Logger";

const scope: ColumnNameScope = {
  entityName: "User",
  valid: new Set(["id", "name", "teamId", "team", "posts"]),
};

describe("collectUnknownWriteKeys", () => {
  it("returns the keys that match nothing in scope, in payload order", () => {
    expect(
      collectUnknownWriteKeys({ name: "a", nmae: "b", id: 1, extra: 2 }, scope),
    ).toEqual(["nmae", "extra"]);
  });

  it("returns an empty list when every key is known", () => {
    expect(
      collectUnknownWriteKeys({ id: 1, name: "a", team: { id: 2 }, posts: [] }, scope),
    ).toEqual([]);
  });

  it("skips undefined values — they are never written anyway", () => {
    expect(collectUnknownWriteKeys({ name: "a", nmae: undefined }, scope)).toEqual([]);
  });

  it("skips function-valued members (methods on an instance)", () => {
    expect(
      collectUnknownWriteKeys({ name: "a", toJSON: () => ({}) }, scope),
    ).toEqual([]);
  });

  it("does not report null — an explicit null is a value to write", () => {
    expect(collectUnknownWriteKeys({ nmae: null }, scope)).toEqual(["nmae"]);
  });

  it("ignores symbol keys and prototype members", () => {
    class Draft {
      name = "a";
      describe() {
        return this.name;
      }
    }
    const item = new Draft() as unknown as Record<string | symbol, unknown>;
    item[Symbol("marker")] = true;
    expect(collectUnknownWriteKeys(item, scope)).toEqual([]);
  });

  it("returns an empty list for non-object payloads", () => {
    expect(collectUnknownWriteKeys(null, scope)).toEqual([]);
    expect(collectUnknownWriteKeys(undefined, scope)).toEqual([]);
    expect(collectUnknownWriteKeys("name", scope)).toEqual([]);
  });
});

describe("validateDatabaseClientOptions - unknownWriteKeys", () => {
  const base: DatabaseClientOptions = {
    type: "sqlite",
    database: ":memory:",
    entities: [],
  };
  let logs: string[];

  beforeEach(() => {
    logs = [];
    Logger.setOutput((msg) => logs.push(msg));
  });

  afterEach(() => {
    Logger.reset();
  });

  it.each(UNKNOWN_WRITE_KEY_POLICIES)("accepts %p", (policy) => {
    expect(() =>
      validateDatabaseClientOptions({ ...base, unknownWriteKeys: policy }),
    ).not.toThrow();
    expect(logs.filter((l) => l.includes("Unknown option"))).toHaveLength(0);
  });

  it("rejects a value outside the policy set, listing the accepted ones", () => {
    expect(() =>
      validateDatabaseClientOptions({
        ...base,
        unknownWriteKeys: "error",
      } as unknown as DatabaseClientOptions),
    ).toThrow(
      /'unknownWriteKeys' must be one of "warn", "throw", "ignore", got "error"/,
    );
  });

  it("is a known key — a typo of it gets the did-you-mean warning", () => {
    validateDatabaseClientOptions({
      ...base,
      unknownWriteKey: "throw",
    } as unknown as DatabaseClientOptions);
    const warning = logs.find((l) => l.includes("Unknown option 'unknownWriteKey'"));
    expect(warning).toContain("Did you mean 'unknownWriteKeys'?");
  });
});
