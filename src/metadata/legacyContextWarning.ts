/**
 * Internal helper that emits a one-shot warning when legacy mutators
 * (`setContext` / `switchContext` / `switchTenant`) are called.
 *
 * These mutators flip a module-global `currentContext` and can leak between
 * concurrent async callers. Production code should drive context switching
 * through {@link MetadataContext.run} (AsyncLocalStorage) instead.
 *
 * The warning fires at most once per `method` per process so it does not
 * flood logs when used inside tight loops, and is suppressed under Jest
 * (which uses these mutators heavily as the simpler test API) and when
 * `STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN=1` is set.
 *
 * @internal
 */
const warned = new Set<string>();

export function warnLegacyContextMutator(method: string): void {
  if (warned.has(method)) return;

  // Skip under Jest — tests use these mutators by design and we don't want
  // to spam the test reporter. Production / dev runs do not set this env.
  if (typeof process !== "undefined") {
    if (process.env.JEST_WORKER_ID) return;
    if (process.env.STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN === "1") return;
  }

  warned.add(method);

  // eslint-disable-next-line no-console
  console.warn(
    `[stingerloom] ${method} mutates a process-global context and is not safe ` +
      `under concurrent requests. Use MetadataContext.run(tenantId, callback) ` +
      `instead. This warning is shown once per process; set ` +
      `STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN=1 to silence it.`,
  );
}

/**
 * Test-only helper to clear the "already warned" set between test files.
 * Not exported from `@stingerloom/orm`.
 *
 * @internal
 */
export function __resetLegacyContextWarnings(): void {
  warned.clear();
}
