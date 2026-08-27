import { AsyncLocalStorage } from "async_hooks";

/**
 * Marks a region of async execution as exempt from the EntityManager's root
 * entity-scope check ({@link EntityManager.assertEntityInScope}).
 *
 * Cascade traversal saves/deletes relation targets through the *public*
 * `em.save`/`em.delete` facades (kept that way so test spies and plugin
 * wrappers observe cascade writes), but a relation target reached only
 * through a cascade may legitimately sit outside the scope of an
 * `attach()`ed EntityManager whose tables another registration owns — so
 * CascadeHandler wraps its work in {@link runScopeExempt} instead of the
 * facades dropping their check.
 */
const scopeExemptStorage = new AsyncLocalStorage<true>();

export function runScopeExempt<R>(fn: () => R): R {
  return scopeExemptStorage.run(true, fn);
}

export function isScopeExempt(): boolean {
  return scopeExemptStorage.getStore() === true;
}
