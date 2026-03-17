import { StingerloomPlugin } from "../StingerloomPlugin";
import { Mutation } from "./Mutation";
import { MutationPluginOptions } from "./MutationPreview";

/**
 * Mutation plugin factory.
 *
 * Adds `mutate()` to the EntityManager, which returns a Mutation instance
 * for tracking entity changes and executing batch flushes.
 *
 * @example
 * ```ts
 * em.extend(mutationPlugin());
 *
 * const mut = em.mutate();
 * const user = await em.findOne(User, { where: { id: 1 } });
 * mut.track(user);
 * user.name = "updated";
 * await mut.flush();
 * ```
 */
export function mutationPlugin(
  opts?: MutationPluginOptions,
): StingerloomPlugin<{ mutate(): Mutation }> {
  return {
    name: "mutation",
    install(ctx) {
      return {
        mutate(): Mutation {
          return new Mutation(ctx, opts);
        },
      };
    },
  };
}
