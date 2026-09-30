import type { ModelRelationField } from "./EntityModel";

/**
 * Source-text helpers shared by the emitters. Every database-supplied string
 * reaches the generated file through {@link lit} or {@link noteLines} — never
 * by interpolating it into code — so a quote, backslash or newline in a table,
 * column, enum value or default cannot break out of its literal.
 */

/** A string as a TypeScript string literal. */
export function lit(value: string): string {
  return JSON.stringify(value);
}

/** `// NOTE:` comment lines for `notes`, each kept on a single line. */
export function noteLines(notes: readonly string[] | undefined, indent = ""): string[] {
  return (notes ?? []).map(
    (note) => `${indent}// NOTE: ${note.replace(/[\r\n\u2028\u2029]+/g, " ")}`,
  );
}

/**
 * FK column options shared by both emitters. The type and nullability are
 * always written out: inferring them from the target's primary key loses a
 * `NOT NULL` and can widen or narrow the column.
 */
export function relationColumnOptions(field: ModelRelationField): string {
  const opts = [
    `name: ${lit(field.fkColumn)}`,
    `type: ${lit(field.fkType)}`,
    `nullable: ${field.fkNullable}`,
  ];
  if (field.referencedColumn) {
    opts.push(`referencedColumn: ${lit(field.referencedColumn)}`);
  }
  return `{ ${opts.join(", ")} }`;
}

/** `onDelete` / `onUpdate` entries for a relation, when it declares any. */
export function referentialActionEntries(field: ModelRelationField): string[] {
  const entries: string[] = [];
  if (field.onDelete) entries.push(`onDelete: ${lit(field.onDelete)}`);
  if (field.onUpdate) entries.push(`onUpdate: ${lit(field.onUpdate)}`);
  return entries;
}
