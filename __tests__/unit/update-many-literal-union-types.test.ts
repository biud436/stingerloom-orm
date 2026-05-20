/**
 * Type-level regression test for `updateMany()` against an entity whose
 * column is a string-literal union rather than a bare `string`.
 *
 * Background (#339): `examples/nestjs-linear-clone` webhook-worker.service.ts
 * carried `as any` on
 *   `updateMany({ state: "in_flight", ... }, { where: { id } })`
 * under the assumption that `UpdateData<T>` / `WhereClause<T>` could not
 * narrow a literal-union column. They can — the casts were stale leftovers.
 * These assertions stop compiling if that narrowing ever regresses.
 *
 * The file is type-checked by ts-jest under `__tests__/tsconfig.json`
 * (`strict: true`); the runtime `expect`s are incidental — the real
 * assertions are the type annotations and the `@ts-expect-error` directive.
 */
import type { BaseRepository } from "../../src/core/BaseRepository";
import type {
  UpdateData,
  UpdateManyOptions,
  WhereClause,
} from "../../src/dialects/FindOption";

type DeliveryState = "pending" | "in_flight" | "delivered" | "failed";

/** Fixture mirroring linear-clone's WebhookDelivery: a literal-union column. */
interface WebhookDelivery {
  id: number;
  state: DeliveryState;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  lastError: string | null;
}

describe("updateMany — literal-union column types (#339)", () => {
  it("UpdateData<T> accepts a literal value for a string-literal-union column", () => {
    const data: UpdateData<WebhookDelivery> = {
      state: "in_flight",
      lastAttemptedAt: new Date(),
    };
    expect(data.state).toBe("in_flight");
  });

  it("UpdateData<T> accepts null for a nullable column alongside a union column", () => {
    const data: UpdateData<WebhookDelivery> = {
      state: "in_flight",
      lastError: null,
    };
    expect(data.lastError).toBeNull();
  });

  it("WhereClause<T> accepts a bare primary-key literal", () => {
    const id = 1;
    const where: WhereClause<WebhookDelivery> = { id };
    expect(where.id).toBe(1);
  });

  it("UpdateManyOptions<T> accepts an inline { where: { id } }", () => {
    const id = 7;
    const options: UpdateManyOptions<WebhookDelivery> = { where: { id } };
    expect(options.where.id).toBe(7);
  });

  it("rejects a value outside the literal union", () => {
    // @ts-expect-error — "archived" is not a DeliveryState; widening
    // UpdateData<T>['state'] back to bare `string` would silently break
    // this and surface the directive as an unused-error.
    const data: UpdateData<WebhookDelivery> = { state: "archived" };
    expect(data).toBeDefined();
  });

  it("BaseRepository.updateMany compiles without a cast for a union column", () => {
    // Never executed — declared purely so ts-jest type-checks the exact
    // call shape that webhook-worker.service.ts uses verbatim. The test
    // passes by virtue of this file compiling.
    async function _compileCheck(
      repo: BaseRepository<WebhookDelivery>,
    ): Promise<void> {
      await repo.updateMany(
        { state: "in_flight", lastAttemptedAt: new Date() },
        { where: { id: 1 } },
      );
      await repo.updateMany(
        { state: "in_flight", lastError: null },
        { where: { id: 1 } },
      );
    }
    expect(typeof _compileCheck).toBe("function");
  });
});
