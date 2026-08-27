/**
 * Process-wide record of every connection name a
 * `StingerloomOrmModule.forRoot()` / `forRootAsync()` call has registered.
 *
 * `forFeature()` cannot check its `connectionName` eagerly — module
 * definitions evaluate in import order, so a feature module's definition may
 * run before the root module's. Instead the repository provider factories
 * (which Nest resolves only after the whole module graph is built) consult
 * this registry to turn an unresolvable EntityManager token into an
 * actionable error naming the known connections.
 */
const registeredConnectionNames = new Set<string>();

export function recordOrmConnectionName(connectionName: string): void {
  registeredConnectionNames.add(connectionName);
}

export function getRecordedOrmConnectionNames(): string[] {
  return [...registeredConnectionNames];
}
