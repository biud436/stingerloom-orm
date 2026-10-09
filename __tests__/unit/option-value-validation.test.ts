/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Every connection option that is set must hold a value it accepts, and a
 * nested options object must not carry a key it does not declare. These
 * values used to pass validation and then either turn the setting off
 * without a word or crash later with a TypeError.
 */
import "reflect-metadata";
import {
  DatabaseClientOptions,
  normalizeSynchronizePolicy,
  validateDatabaseClientOptions,
} from "../../src/core/DatabaseClientOptions";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";
import { DefaultNamingStrategy } from "../../src/core/generators/NamingStrategy";
import {
  Transactional,
  TransactionPropagation,
  validateTransactionOptions,
} from "../../src/decorators/Transactional";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const sqlite: DatabaseClientOptions = { type: "sqlite", database: ":memory:", entities: [] };
const postgres: DatabaseClientOptions = {
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "u",
  password: "p",
  database: "app",
  entities: [],
};

function errorOf(fn: () => unknown): any {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function problemsWith(extra: Record<string, unknown>, base: DatabaseClientOptions = sqlite): string {
  const error = errorOf(() => validateDatabaseClientOptions({ ...base, ...extra } as any));
  if (!error) throw new Error(`expected ${JSON.stringify(extra)} to be rejected`);
  expect(error.code).toBe(OrmErrorCode.INVALID_CONFIG);
  return error.message;
}

const node = { host: "replica", port: 5432, username: "u", password: "p", database: "app" };

describe("connection option values", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["a synchronize string that is not a mode", { synchronize: "yes" }, `'synchronize' must be true, false, "safe", "dry-run" or an options object`],
    ["a synchronize mode typo", { synchronize: "save" }, `Did you mean "safe"?`],
    ["a synchronize number", { synchronize: 1 }, "got 1."],
    ["a synchronize object without a mode", { synchronize: {} }, "'synchronize.mode' is required."],
    ["a synchronize object with an unknown mode", { synchronize: { mode: "yes" } }, `'synchronize.mode' must be one of true, "safe", "dry-run", got "yes".`],
    ["a synchronize object with an unknown key", { synchronize: { mode: true, continueOnErorr: false } }, `'synchronize' has no option 'continueOnErorr'. Did you mean 'continueOnError'?`],
    ["a tenantStrategy typo", { tenantStrategy: "tenant-column" }, `'tenantStrategy' must be one of "search_path", "schema_qualified", "tenant_column", "database", got "tenant-column". Did you mean "tenant_column"?`],
    ["a tenantOnMissingContext typo", { tenantOnMissingContext: "warns" }, `Did you mean "warn"?`],
    ["a publicTenantBehavior typo", { publicTenantBehavior: "throws" }, `Did you mean "throw"?`],
    ["a tenantColumnType outside the list", { tenantColumnType: "text" }, `'tenantColumnType' must be one of`],
    ["a zero tenantColumnLength", { tenantColumnLength: 0 }, "'tenantColumnLength' must be a positive integer, got 0."],
    ["an empty tenantColumnName", { tenantColumnName: "" }, "'tenantColumnName' must be a non-empty string"],
    ["a tenantDatabaseMap entry that is not a name", { tenantDatabaseMap: { acme: 1 } }, "'tenantDatabaseMap.acme' must be a non-empty string, got 1."],
    ["a tenantDatabaseResolver that is not a function", { tenantDatabaseResolver: "acme" }, "'tenantDatabaseResolver' must be a function"],
    ["eagerProvisionTenants that is not an array", { eagerProvisionTenants: "acme" }, "'eagerProvisionTenants' must be an array"],
    ["a negative tenantConnectionTtlMs", { tenantConnectionTtlMs: -1 }, "'tenantConnectionTtlMs' must be a non-negative number"],
    ["logging as a string", { logging: "true" }, `'logging' must be a boolean or an options object, got "true".`],
    ["a logging option typo", { logging: { querys: true } }, `'logging' has no option 'querys'. Did you mean 'queries'?`],
    ["a non-integer maxLogEntries", { logging: { maxLogEntries: 1.5 } }, "'logging.maxLogEntries' must be a positive integer, got 1.5."],
    ["a zero connectionLimit", { connectionLimit: 0 }, "'connectionLimit' must be a positive integer, got 0."],
    ["connectionLimit as a string", { connectionLimit: "10" }, `'connectionLimit' must be a positive integer, got "10".`],
    ["a pool option typo", { pool: { maxx: 10 } }, `'pool' has no option 'maxx'. Did you mean 'max'?`],
    ["a fractional pool.max", { pool: { max: 2.5 } }, "'pool.max' must be a positive integer, got 2.5."],
    ["pool.min above pool.max", { pool: { min: 5, max: 2 } }, "'pool.min' (5) cannot exceed 'pool.max' (2)."],
    ["a cache option typo", { cache: { ttll: 500 } }, `'cache' has no option 'ttll'. Did you mean 'ttl'?`],
    ["a cache store missing a method", { cache: { store: { get() {}, set() {}, invalidateTags() {} } } }, "'cache.store' is not a QueryCacheStore: missing clear()."],
    ["a NaN queryTimeout", { queryTimeout: NaN }, "'queryTimeout' must be a non-negative number, got NaN."],
    ["an Infinity queryTimeout", { queryTimeout: Infinity }, "got Infinity."],
    ["datesStrings as a string", { datesStrings: "yes" }, "'datesStrings' must be a boolean"],
    ["a retry option typo", { retry: { attempts: 3 } }, "'retry' has no option 'attempts'."],
    ["a zero retry.maxAttempts", { retry: { maxAttempts: 0 } }, "'retry.maxAttempts' must be a positive integer, got 0."],
    ["a namingStrategy name instead of an instance", { namingStrategy: "snake" }, `'namingStrategy' must be a NamingStrategy, got "snake". Pass an instance such as new SnakeNamingStrategy()`],
    ["a namingStrategy class instead of an instance", { namingStrategy: SnakeNamingStrategy }, "'namingStrategy' must be a NamingStrategy, got a function."],
    ["a namingStrategy missing methods", { namingStrategy: { tableName: (n: string) => n } }, "missing columnName(), joinColumnName()"],
    ["a plugin without install()", { plugins: [{ name: "audit" }] }, "'plugins[0]' is not a StingerloomPlugin: missing install()."],
    ["a plugin without a name", { plugins: [{ install() {} }] }, "'plugins[0].name' must be a non-empty string, got undefined."],
    ["an entity entry that is neither a class nor a pattern", { entities: [null] }, "'entities[0]' must be an entity class or a glob pattern, got null."],
    ["entities that is not an array", { entities: "src/**/*.entity.ts" }, `'entities' must be an array, got "src/**/*.entity.ts".`],
    ["a replication strategy typo", { replication: { master: node, slaves: [node], strategy: "roundrobin" } }, `Did you mean "round-robin"?`],
    ["replication slaves that is not an array", { replication: { master: node, slaves: "replica" } }, "'replication.slaves' must be an array"],
    ["no replication slaves", { replication: { master: node, slaves: [] } }, "'replication.slaves' must not be empty."],
    ["a replica without a database", { replication: { master: node, slaves: [{ ...node, database: undefined }] } }, "'replication.slaves[0].database' is required."],
    ["a health check without enabled", { replication: { master: node, slaves: [node], healthCheck: { intervalMs: 1000 } } }, "'replication.healthCheck.enabled' is required."],
    ["a type typo", { type: "postgresql" }, `Did you mean "postgres"?`],
  ])("rejects %s", (_label, extra, expected) => {
    expect(problemsWith(extra)).toContain(expected);
  });

  it("checks server connection values only for server types", () => {
    expect(problemsWith({ port: "5432" }, postgres)).toContain(`'port' must be an integer between 1 and 65535, got "5432".`);
    expect(problemsWith({ ssl: "on" }, postgres)).toContain(`'ssl' must be a boolean or an options object, got "on".`);
    expect(() => validateDatabaseClientOptions({ ...sqlite, port: "5432" } as any)).not.toThrow();
  });

  it("passes SSL keys the driver reads through", () => {
    expect(() =>
      validateDatabaseClientOptions({ ...postgres, ssl: { ca: "pem", servername: "db", rejectUnauthorized: false } } as any),
    ).not.toThrow();
  });

  it("lists every problem in one error", () => {
    const message = problemsWith({ tenantStrategy: "tenant-column", pool: { maxx: 10 }, logging: "true" });
    expect(message.match(/\n {2}- /g)).toHaveLength(3);
  });

  it("accepts every documented value", () => {
    const store = { get() {}, set() {}, invalidateTags() {}, clear() {} };
    const accepted: Array<Record<string, unknown>> = [
      { synchronize: true },
      { synchronize: false },
      { synchronize: "safe" },
      { synchronize: "dry-run" },
      { synchronize: { mode: "safe", continueOnError: false, failOnDestructiveChange: true, logDDL: true } },
      { logging: true },
      { logging: { queries: true, slowQueryMs: 0, nPlusOne: true, enableQueryTracking: false, maxLogEntries: 10, ttlMs: 500 } },
      { cache: false },
      { cache: { ttl: 1, maxEntries: 1, store } },
      { pool: { max: 1, min: 0, acquireTimeoutMs: 0, idleTimeoutMs: 0, leakDetectionThresholdMs: 0, validateOnBorrow: true } },
      { retry: {} },
      { retry: { maxAttempts: 5 } },
      { retry: { maxAttempts: 1, backoffMs: 0 } },
      { queryTimeout: 0 },
      { connectionLimit: 5 },
      { namingStrategy: new SnakeNamingStrategy() },
      { namingStrategy: new DefaultNamingStrategy() },
      { plugins: [{ name: "audit", install() {} }] },
      { entities: [class A {}, "src/**/*.entity.ts"] },
      { tenantStrategy: "tenant_column", tenantColumnName: "org_id", tenantColumnType: "uuid", tenantColumnLength: 36, tenantOnMissingContext: "throw" },
      { tenantStrategy: "database", tenantDatabaseMap: { acme: "acme_db" }, tenantDatabaseResolver: () => "acme_db", eagerProvisionTenants: ["acme"], publicTenantBehavior: "throw", tenantConnectionTtlMs: 0 },
      { replication: { master: node, slaves: [node], strategy: "random", healthCheck: { enabled: true, intervalMs: 100, query: "SELECT 1", failureThreshold: 1, recoveryThreshold: 1 } } },
      { schema: "tenant_a", charset: "utf8mb4", datesStrings: true, unknownWriteKeys: "throw", versionOverride: "16.2" },
    ];
    for (const extra of accepted) {
      expect(errorOf(() => validateDatabaseClientOptions({ ...postgres, ...extra } as any))).toBeNull();
    }
  });
});

describe("normalizeSynchronizePolicy", () => {
  it("throws for a value that is not a mode instead of syncing without one", () => {
    const error = errorOf(() => normalizeSynchronizePolicy("yes" as any));
    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain(`'synchronize' must be true, false, "safe", "dry-run"`);
    expect(normalizeSynchronizePolicy({ mode: "safe" }).mode).toBe("safe");
  });
});

describe("transaction options", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["a propagation typo", { propagation: "REQUIRES_NEWW" }, `Invalid transaction propagation: "REQUIRES_NEWW". Did you mean "REQUIRES_NEW"?`],
    ["a lowercase propagation", { propagation: "nested" }, `Did you mean "NESTED"?`],
    ["an isolation level typo", { isolationLevel: "SERIALISABLE" }, `Invalid transaction isolation level: "SERIALISABLE". Did you mean "SERIALIZABLE"?`],
    ["a negative maxRetries", { maxRetries: -1 }, "'maxRetries' must be a non-negative integer, got -1."],
    ["a NaN retryDelayMs", { retryDelayMs: NaN }, "'retryDelayMs' must be a non-negative number, got NaN."],
  ])("rejects %s", (_label, options, expected) => {
    const error = errorOf(() => validateTransactionOptions(options));
    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain(expected);
  });

  it("accepts a propagation as the enum member or its string value", () => {
    expect(errorOf(() => validateTransactionOptions({ propagation: TransactionPropagation.NESTED }))).toBeNull();
    expect(errorOf(() => validateTransactionOptions({ propagation: "REQUIRES_NEW", isolationLevel: "READ COMMITTED" }))).toBeNull();
  });

  it("rejects a bad @Transactional option when the class is defined", () => {
    const define = () => {
      class Service {
        @Transactional({ propagation: "REQUIRED_NEW" as any })
        async run() {}
      }
      return Service;
    };
    expect(errorOf(define)?.message).toContain(`Did you mean "REQUIRES_NEW"?`);

    const defineIsolation = () => {
      class Service {
        @Transactional("REPEATABLE_READ" as any)
        async run() {}
      }
      return Service;
    };
    expect(errorOf(defineIsolation)?.message).toContain(`Did you mean "REPEATABLE READ"?`);
  });
});
