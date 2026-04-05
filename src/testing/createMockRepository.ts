/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseRepository } from "../core/BaseRepository";
import { ClazzType } from "../utils/types";

type MockMethods<T> = Partial<{
  [K in keyof BaseRepository<T>]: BaseRepository<T>[K] extends (...args: any[]) => any
    ? (...args: Parameters<BaseRepository<T>[K]>) => ReturnType<BaseRepository<T>[K]>
    : never;
}>;

/**
 * Creates a mock BaseRepository with overridden methods for testing.
 * Methods not overridden will throw an error when called.
 *
 * @example
 * ```ts
 * import { createMockRepository } from "@stingerloom/orm/testing";
 *
 * const mockRepo = createMockRepository(User, {
 *   find: async () => [{ id: 1, name: "test" }],
 *   findOne: async () => ({ id: 1, name: "test" }),
 *   count: async () => 1,
 * });
 *
 * const users = await mockRepo.find();
 * // [{ id: 1, name: "test" }]
 * ```
 */
export function createMockRepository<T>(
  _entity: ClazzType<T>,
  overrides: MockMethods<T> = {},
): BaseRepository<T> {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop in overrides) {
        return (overrides as any)[prop];
      }
      if (typeof prop === "string") {
        return (..._args: any[]) => {
          throw new Error(
            `MockRepository: method "${prop}" was called but not mocked. ` +
              `Add it to the overrides parameter.`,
          );
        };
      }
      return undefined;
    },
  };

  return new Proxy({}, handler) as BaseRepository<T>;
}
