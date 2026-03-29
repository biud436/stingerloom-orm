import type { ClazzType } from "../../../utils/types";
import type { StingerloomPlugin } from "../StingerloomPlugin";
import { RawPipeline, RawPipelineOptions } from "./RawPipeline";

/**
 * RawPipeline plugin factory.
 *
 * Adds `pipe()` to the EntityManager, which returns a RawPipeline instance
 * for large-data processing without entity transformation overhead.
 *
 * @example
 * ```ts
 * em.extend(rawPipelinePlugin());
 *
 * // Stream raw rows without entity instantiation
 * const pipeline = em.pipe(User, { where: { active: true }, batchSize: 5000 });
 * for await (const batch of pipeline.raw()) {
 *   sendToGrpc(batch);
 * }
 *
 * // Binary mode (driver-level raw buffers)
 * for await (const batch of pipeline.binary()) {
 *   writeToFile(batch);
 * }
 *
 * // ETL transformation chain
 * const results = await em.pipe(User)
 *   .map(row => ({ id: row.id, name: row.name }))
 *   .collect();
 * ```
 */
export function rawPipelinePlugin(): StingerloomPlugin<{
  pipe<T>(entity: ClazzType<T>, options?: RawPipelineOptions<T>): RawPipeline<T>;
}> {
  return {
    name: "raw-pipeline",
    install(ctx) {
      return {
        pipe<T>(
          entity: ClazzType<T>,
          options: RawPipelineOptions<T> = {},
        ): RawPipeline<T> {
          return new RawPipeline(ctx, entity, options);
        },
      };
    },
  };
}
