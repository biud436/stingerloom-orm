import { AsyncLocalStorage } from "async_hooks";

/**
 * Marks a region of async execution as running a statement the ORM built
 * itself, so `em.query()` does not report it as raw SQL bypassing the
 * `tenant_column` predicate ({@link TenantScopeManager.warnIfRawQueryBypassesTenant}).
 *
 * The query builder, the write buffer and the raw pipeline execute their
 * statements through the *public* `em.query()` facade (kept that way so test
 * spies and plugin wrappers observe them), and such a statement is either scoped already or
 * reads no tenant rows — so those call sites wrap the call in
 * {@link runInternalQuery} instead of the warning guessing its caller from
 * stack-frame file names, which a bundle collapses into one file.
 */
const internalQueryStorage = new AsyncLocalStorage<true>();

export function runInternalQuery<R>(fn: () => R): R {
  return internalQueryStorage.run(true, fn);
}

export function isInternalQuery(): boolean {
  return internalQueryStorage.getStore() === true;
}
