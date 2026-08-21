/**
 * The "Did you mean ...?" hint shared by the relation-name and column-name
 * guards. A wrong guess is worse than no guess, so the threshold matters as
 * much as the distance.
 */
import { closestIdentifier } from "../../src/utils/closestIdentifier";

describe("closestIdentifier", () => {
  const columns = ["firstName", "lastName", "createdAt", "id"];

  it("finds a one-character typo", () => {
    expect(closestIdentifier("firstNam", columns)).toBe("firstName");
    expect(closestIdentifier("lastNmae", columns)).toBe("lastName");
  });

  it("treats a case-only mismatch as the intended identifier", () => {
    expect(closestIdentifier("FIRSTNAME", columns)).toBe("firstName");
    expect(closestIdentifier("createdat", columns)).toBe("createdAt");
  });

  it("stays silent when nothing is close enough", () => {
    expect(closestIdentifier("zzzzzzzz", columns)).toBeNull();
    expect(closestIdentifier("workspaceSlug", columns)).toBeNull();
  });

  it("scales the threshold with the name length", () => {
    // Two edits on a short name is too far; the same distance on a long one is
    // still a plausible typo.
    expect(closestIdentifier("ib", ["id"])).toBe("id");
    expect(closestIdentifier("xy", ["id"])).toBeNull();
    expect(closestIdentifier("creatdAtt", columns)).toBe("createdAt");
  });

  it("ignores empty candidates and an empty candidate set", () => {
    expect(closestIdentifier("id", [])).toBeNull();
    expect(closestIdentifier("id", ["", "id"])).toBe("id");
  });
});
