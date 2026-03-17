import { StingerloomPlugin } from "../StingerloomPlugin";
import { WriteBuffer } from "./WriteBuffer";
import { BufferPluginOptions } from "./BufferPreview";

/**
 * Buffer plugin factory.
 *
 * Adds `buffer()` to the EntityManager, which returns a WriteBuffer instance
 * for tracking entity changes and executing batch flushes.
 *
 * @example
 * ```ts
 * em.extend(bufferPlugin());
 *
 * const buf = em.buffer();
 * const user = await buf.findOne(User, { where: { id: 1 } });
 * user.name = "updated";
 * await buf.flush();
 * ```
 */
export function bufferPlugin(
  opts?: BufferPluginOptions,
): StingerloomPlugin<{ buffer(): WriteBuffer }> {
  return {
    name: "buffer",
    install(ctx) {
      return {
        buffer(): WriteBuffer {
          return new WriteBuffer(ctx, opts);
        },
      };
    },
  };
}
