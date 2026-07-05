/* eslint-disable @typescript-eslint/no-explicit-any */
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import type {
  StingerloomPlugin,
  InstalledPlugin,
  QueryInfo,
} from "../plugin/StingerloomPlugin";
import type { PluginContext } from "../plugin/PluginContext";
import type { EntityManagerInternals } from "../EntityManagerInternals";

/**
 * Host-side hooks the PluginManager needs from the EntityManager class
 * itself (statics and prototype introspection) that the `_ctx` bridge does
 * not carry. Kept as injected closures so this file never imports the
 * EntityManager class at runtime.
 */
export interface PluginHostHooks {
  /** True when `name` is a plugin-overridable placeholder stub (e.g. `buffer`, `pipe`). */
  isPlaceholder(name: string): boolean;
  /** Own property names of `EntityManager.prototype` — the reserved member set. */
  reservedMemberNames(): string[];
  /** Registers a new placeholder name (delegates to the EntityManager static). */
  registerPlaceholder(name: string): void;
}

/**
 * Owns the installed-plugin registry and the plugin lifecycle extracted from
 * EntityManager: `extend()` installation (dependency check, conflict check,
 * API mixin), the lazy `PluginContext`, the before/after query/transaction
 * hook fan-out, and LIFO shutdown.
 *
 * The facade keeps thin delegators (`em.extend` / `em.hasPlugin` /
 * `em.getPluginApi` / `em.notifyPluginBeforeQuery` / ...) so the public API
 * and test touchpoints stay identical.
 *
 * @internal Package-internal — not a public API.
 */
export class PluginManager {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private pluginContext: PluginContext | null = null;

  constructor(
    private readonly ctx: EntityManagerInternals,
    private readonly hooks: PluginHostHooks,
  ) {}

  /**
   * Install a plugin on the owning EntityManager instance.
   * Idempotent — installing the same plugin name twice is a no-op.
   */
  extend<TApi extends Record<string, any>>(
    plugin: StingerloomPlugin<TApi>,
  ): void {
    // Idempotent: skip if already installed
    if (this.plugins.has(plugin.name)) {
      return;
    }

    // Check dependencies
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new OrmError(
            OrmErrorCode.PLUGIN_DEPENDENCY_MISSING,
            `Plugin "${plugin.name}" requires "${dep}" to be installed first`,
            `Call em.extend(${dep}Plugin) before em.extend(${plugin.name}Plugin)`,
          );
        }
      }
    }

    // Create context (lazy singleton)
    const context = this.getContext();

    // Install
    const api = (plugin.install(context) ?? {}) as Record<string, any>;

    // Check for conflicts with existing properties
    const manager = this.ctx.getManager() as any;
    const reserved = new Set(this.hooks.reservedMemberNames());
    for (const key of Object.keys(api)) {
      // Allow plugins to override placeholder stubs (e.g. mutate())
      if (this.hooks.isPlaceholder(key)) {
        continue;
      }
      if (key in manager || reserved.has(key)) {
        throw new OrmError(
          OrmErrorCode.PLUGIN_CONFLICT,
          `Plugin "${plugin.name}" method "${key}" conflicts with an existing EntityManager member`,
          `Rename the "${key}" method in the plugin's install() return object`,
        );
      }
    }

    // Mix API methods into the EntityManager instance
    for (const [key, value] of Object.entries(api)) {
      manager[key] = value;
    }

    // Store
    this.plugins.set(plugin.name, { plugin, api });
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  getApi<T = unknown>(name: string): T | undefined {
    const installed = this.plugins.get(name);
    return installed ? (installed.api as T) : undefined;
  }

  /**
   * Create or return the cached PluginContext for the owning EntityManager.
   */
  getContext(): PluginContext {
    if (!this.pluginContext) {
      const ctx = this.ctx;
      this.pluginContext = {
        get em() {
          return ctx.getManager();
        },
        get driver() {
          return ctx.getDriver();
        },
        get events() {
          return ctx.getEventEmitter();
        },
        get connectionName() {
          return ctx.getManager().getConnectionName();
        },
        addSubscriber: (s) => ctx.getManager().addSubscriber(s),
        removeSubscriber: (s) => ctx.getManager().removeSubscriber(s),
        getEntities: () => ctx.getEntities(),
        getPlugin: <T = unknown>(name: string) => this.getApi<T>(name),
        isMySqlFamily: () => ctx.isMySqlFamily(),
        isPostgres: () => ctx.isPostgres(),
        isSqlite: () => ctx.isSqlite(),
        wrap: (id) => ctx.wrap(id),
        wrapTable: (t) => ctx.wrapTable(t),
        executeInTransaction: (fn) => ctx.executeInTransaction(fn),
        executeReadOnly: (fn) => ctx.executeReadOnly(fn),
        getEntityMetadata: (entity) => ctx.getManager().getEntityMetadata(entity),
        registerPlaceholder: (name) => this.hooks.registerPlaceholder(name),
      };
    }
    return this.pluginContext;
  }

  // ── Plugin Query Hooks (#228) ─────────────────────────────

  /** Notify installed plugins before a query executes. */
  notifyBeforeQuery(queryInfo: QueryInfo): QueryInfo {
    let info = queryInfo;
    for (const { plugin } of this.plugins.values()) {
      if (plugin.beforeQuery) {
        const result = plugin.beforeQuery(info);
        if (result) info = result;
      }
    }
    return info;
  }

  /** Notify installed plugins after a query executes. */
  notifyAfterQuery(queryInfo: QueryInfo, result: any, durationMs: number): void {
    for (const { plugin } of this.plugins.values()) {
      if (plugin.afterQuery) {
        plugin.afterQuery(queryInfo, result, durationMs);
      }
    }
  }

  /** Notify installed plugins before a transaction. */
  notifyBeforeTransaction(isolationLevel?: string): void {
    for (const { plugin } of this.plugins.values()) {
      if (plugin.beforeTransaction) {
        plugin.beforeTransaction(isolationLevel);
      }
    }
  }

  /** Notify installed plugins after a transaction. */
  notifyAfterTransaction(committed: boolean): void {
    for (const { plugin } of this.plugins.values()) {
      if (plugin.afterTransaction) {
        plugin.afterTransaction(committed);
      }
    }
  }

  /**
   * Shuts down every installed plugin in reverse installation order (LIFO),
   * then clears the registry and the cached context (propagateShutdown path).
   */
  async shutdownAll(): Promise<void> {
    const pluginEntries = [...this.plugins.values()].reverse();
    for (const { plugin } of pluginEntries) {
      if (plugin.shutdown) {
        try {
          await plugin.shutdown();
        } catch (err) {
          this.ctx.getLogger().warn(
            `[Shutdown] Plugin "${plugin.name}" shutdown error: ${err}`,
          );
        }
      }
    }
    this.plugins.clear();
    this.pluginContext = null;
  }
}
