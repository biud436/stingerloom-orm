import "reflect-metadata";
import { unsupportedExpression } from "../../src/errors/UnsupportedExpressionError";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

describe("unsupportedExpression() helper", () => {
  it("builds an OrmError with UNSUPPORTED_OPERATION code", () => {
    const err = unsupportedExpression({
      feature: "feature_x",
      dialect: "mysql",
      why: "why_text",
      alternative: "alt_text",
    });
    expect(err).toBeInstanceOf(OrmError);
    expect(err.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
  });

  it("includes feature, dialect, why, and alternative in the message", () => {
    const err = unsupportedExpression({
      feature: "percentile_cont",
      dialect: "mysql",
      why: "MySQL has no ordered-set aggregates.",
      alternative: "Use a CTE + ROW_NUMBER().",
    });
    expect(err.message).toContain("percentile_cont");
    expect(err.message).toContain("mysql");
    expect(err.message).toContain("MySQL has no ordered-set aggregates.");
    expect(err.message).toContain("Alternative: Use a CTE + ROW_NUMBER().");
  });

  it("includes the approximate hint when provided", () => {
    const err = unsupportedExpression({
      feature: "f",
      dialect: "mysql",
      why: "y",
      alternative: "a",
      approximate: "histogram bucketing",
    });
    expect(err.message).toContain("Approximate: histogram bucketing");
  });

  it("omits the approximate hint when not provided", () => {
    const err = unsupportedExpression({
      feature: "f",
      dialect: "mysql",
      why: "y",
      alternative: "a",
    });
    expect(err.message).not.toContain("Approximate:");
  });

  it("includes a docs pointer (default or explicit)", () => {
    const def = unsupportedExpression({
      feature: "f",
      dialect: "mysql",
      why: "y",
      alternative: "a",
    });
    expect(def.message).toContain("See: docs/cookbook.md");

    const explicit = unsupportedExpression({
      feature: "f",
      dialect: "mysql",
      why: "y",
      alternative: "a",
      docs: "docs/recipes/percentile.md",
    });
    expect(explicit.message).toContain("See: docs/recipes/percentile.md");
  });

  it("surfaces the alternative as the OrmError.suggestion field", () => {
    const err = unsupportedExpression({
      feature: "f",
      dialect: "mysql",
      why: "y",
      alternative: "fall back to em.query()",
    });
    expect(err.suggestion).toBe("fall back to em.query()");
  });
});
