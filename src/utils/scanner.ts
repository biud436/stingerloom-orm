/**
 * Create a unique entity key
 * Simplified version without scanner dependency
 */
export function createEntityKey(name: string, uniqueId?: string): string {
  const id = uniqueId || Date.now().toString(36) + Math.random().toString(36);
  return `${name}_${id}`;
}
