import "reflect-metadata";

/**
 * Regression tests for #282 — legacy context mutators must carry a one-shot
 * runtime warning so misuse from production code is visible during dev runs.
 *
 * The warning helper suppresses itself under Jest by default (otherwise it
 * would flood the rest of the suite that uses these mutators by design).
 * To exercise it here we toggle env vars before importing the module under
 * test so the cached `process.env.JEST_WORKER_ID` check is re-evaluated.
 */
describe("legacyContextWarning", () => {
  let originalJestId: string | undefined;
  let originalSuppress: string | undefined;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    originalJestId = process.env.JEST_WORKER_ID;
    originalSuppress = process.env.STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN;
    delete process.env.JEST_WORKER_ID;
    delete process.env.STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN;
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.resetModules();
  });

  afterEach(() => {
    if (originalJestId !== undefined) {
      process.env.JEST_WORKER_ID = originalJestId;
    } else {
      delete process.env.JEST_WORKER_ID;
    }
    if (originalSuppress !== undefined) {
      process.env.STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN = originalSuppress;
    } else {
      delete process.env.STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN;
    }
    warnSpy.mockRestore();
  });

  it("emits exactly one warning per method per process", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      warnLegacyContextMutator,
    } = require("../../src/metadata/legacyContextWarning");

    warnLegacyContextMutator("MetadataLayerRegistry.setContext");
    warnLegacyContextMutator("MetadataLayerRegistry.setContext");
    warnLegacyContextMutator("MetadataLayerRegistry.setContext");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      "MetadataLayerRegistry.setContext",
    );
    expect(warnSpy.mock.calls[0][0]).toContain("MetadataContext.run");
  });

  it("warns separately for each method label", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      warnLegacyContextMutator,
    } = require("../../src/metadata/legacyContextWarning");

    warnLegacyContextMutator("A");
    warnLegacyContextMutator("B");
    warnLegacyContextMutator("A"); // de-duped
    warnLegacyContextMutator("B"); // de-duped

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("respects STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN=1", () => {
    process.env.STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN = "1";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      warnLegacyContextMutator,
    } = require("../../src/metadata/legacyContextWarning");

    warnLegacyContextMutator("MetadataLayerRegistry.setContext");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays silent under Jest by default", () => {
    process.env.JEST_WORKER_ID = "1";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      warnLegacyContextMutator,
    } = require("../../src/metadata/legacyContextWarning");

    warnLegacyContextMutator("MetadataLayerRegistry.setContext");

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
