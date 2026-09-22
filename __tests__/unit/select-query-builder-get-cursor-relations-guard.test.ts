import "reflect-metadata";
import { createQbFor, User } from "./golden-sql/fixtures";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

/**
 * `CursorPaginationOption.relations` is a findWithCursor feature: the
 * builder loads nothing implicitly, so a relation on a getCursor() page
 * comes from a *AndSelect join declared on the builder. Passing the option
 * to getCursor() must fail loudly rather than be silently dropped.
 */
describe("SelectQueryBuilder.getCursor() — relations option guard", () => {
  it("rejects a non-empty relations option with InvalidQueryError", async () => {
    const qb = createQbFor(User, "u", "postgres");
    await expect(
      qb.getCursor({ take: 10, orderBy: "id", relations: ["department"] }),
    ).rejects.toThrow(InvalidQueryError);
    await expect(
      qb.getCursor({ take: 10, orderBy: "id", relations: ["department"] }),
    ).rejects.toThrow(/does not accept the relations option/);
  });

  it("an empty relations array is a no-op, not an error", async () => {
    const qb = createQbFor(User, "u", "postgres");
    const page = await qb.getCursor({ take: 10, orderBy: "id", relations: [] });
    expect(page.data).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });
});
