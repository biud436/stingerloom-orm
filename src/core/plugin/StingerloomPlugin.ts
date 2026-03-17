/* eslint-disable @typescript-eslint/no-explicit-any */
import { PluginContext } from "./PluginContext";

/**
 * Stingerloom ORM plugin interface.
 *
 * Plugins extend EntityManager with additional functionality
 * without coupling advanced features into the core.
 *
 * @example
 * ```ts
 * const auditPlugin: StingerloomPlugin<{ getAuditLog(): AuditEntry[] }> = {
 *   name: "audit",
 *   install(ctx) {
 *     const log: AuditEntry[] = [];
 *     ctx.events.on("afterInsert", (p) => log.push({ op: "insert", ...p }));
 *     return { getAuditLog: () => [...log] };
 *   },
 * };
 *
 * em.extend(auditPlugin);
 * em.getAuditLog(); // typed!
 * ```
 */
export interface StingerloomPlugin<TApi = {}> {
  /** Unique plugin name (used for dependency resolution and dedup) */
  readonly name: string;

  /** Names of plugins that must be installed before this one */
  readonly dependencies?: readonly string[];

  /**
   * Called once when the plugin is installed via `em.extend(plugin)`.
   * May return an API object whose methods will be mixed into the EntityManager instance.
   */
  install(context: PluginContext): TApi | void;

  /**
   * Called during `propagateShutdown()` in reverse installation order.
   * Used to clean up plugin resources (timers, connections, caches, etc.).
   */
  shutdown?(): Promise<void> | void;
}

/**
 * Internal record of an installed plugin.
 * @internal
 */
export interface InstalledPlugin {
  plugin: StingerloomPlugin<any>;
  api: Record<string, any>;
}
