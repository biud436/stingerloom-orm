/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityManager } from "../core/EntityManager";

/**
 * Context passed to seeder run/revert methods.
 */
export interface SeederContext {
  em: EntityManager;
}

/**
 * Abstract base class for database seeders.
 *
 * Implement `run()` to insert seed data and optionally `revert()` to remove it.
 *
 * @example
 * ```ts
 * class UserSeeder extends Seeder {
 *   async run(ctx: SeederContext): Promise<void> {
 *     await ctx.em.save(User, { name: "Alice", email: "alice@example.com" });
 *   }
 *   async revert(ctx: SeederContext): Promise<void> {
 *     await ctx.em.delete(User, { email: "alice@example.com" });
 *   }
 * }
 * ```
 */
export abstract class Seeder {
  /**
   * Seeder name. Defaults to the class name.
   */
  get name(): string {
    return this.constructor.name;
  }

  /**
   * Execute the seeder — insert seed data.
   */
  abstract run(ctx: SeederContext): Promise<void>;

  /**
   * Revert the seeder — remove seed data.
   * Optional: if not implemented, revertLast() will skip this seeder.
   */
  revert?(ctx: SeederContext): Promise<void>;
}
