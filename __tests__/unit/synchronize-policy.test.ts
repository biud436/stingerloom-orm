import {
  normalizeSynchronizePolicy,
  SynchronizeOption,
} from "../../src/core/DatabaseClientOptions";

describe("normalizeSynchronizePolicy()", () => {
  describe("bare-form values map to the historical defaults", () => {
    const cases: Array<{
      input: SynchronizeOption | undefined;
      expectedMode: false | true | "safe" | "dry-run";
    }> = [
      { input: undefined, expectedMode: false },
      { input: false, expectedMode: false },
      { input: true, expectedMode: true },
      { input: "safe", expectedMode: "safe" },
      { input: "dry-run", expectedMode: "dry-run" },
    ];

    for (const { input, expectedMode } of cases) {
      it(`normalizes ${JSON.stringify(input)} to mode=${JSON.stringify(expectedMode)}`, () => {
        const policy = normalizeSynchronizePolicy(input);
        expect(policy.mode).toBe(expectedMode);
        // Historical defaults preserved
        expect(policy.continueOnError).toBe(true);
        expect(policy.failOnDestructiveChange).toBe(false);
        expect(policy.logDDL).toBe(false);
      });
    }
  });

  it("options-object form passes mode through", () => {
    expect(normalizeSynchronizePolicy({ mode: true }).mode).toBe(true);
    expect(normalizeSynchronizePolicy({ mode: "safe" }).mode).toBe("safe");
    expect(normalizeSynchronizePolicy({ mode: "dry-run" }).mode).toBe(
      "dry-run",
    );
  });

  it("options-object form respects explicit flag values", () => {
    const policy = normalizeSynchronizePolicy({
      mode: true,
      continueOnError: false,
      failOnDestructiveChange: true,
      logDDL: true,
    });
    expect(policy.continueOnError).toBe(false);
    expect(policy.failOnDestructiveChange).toBe(true);
    expect(policy.logDDL).toBe(true);
  });

  it("options-object form fills in historical defaults for omitted flags", () => {
    const policy = normalizeSynchronizePolicy({ mode: "safe" });
    expect(policy.continueOnError).toBe(true);
    expect(policy.failOnDestructiveChange).toBe(false);
    expect(policy.logDDL).toBe(false);
  });

  it("options-object form preserves false explicit values (does not coerce to default)", () => {
    const policy = normalizeSynchronizePolicy({
      mode: true,
      continueOnError: false,
      logDDL: false,
    });
    expect(policy.continueOnError).toBe(false);
    expect(policy.logDDL).toBe(false);
  });
});
