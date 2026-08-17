/**
 * Wall-clock budgets for the stress suites.
 *
 * The absolute thresholds were written against a developer laptop. Shared CI
 * runners are slower and noisy neighbours are normal, so the budgets are
 * multiplied there instead of being deleted — the suites still catch an
 * order-of-magnitude regression, which is what they are for. Relative
 * assertions (batch INSERT beats per-row INSERT) carry no slack: they compare
 * two measurements taken on the same machine.
 */
const SLACK = process.env.CI ? 4 : 1;

/** Milliseconds allowed for an operation budgeted at `ms` locally. */
export function budget(ms: number): number {
  return ms * SLACK;
}
