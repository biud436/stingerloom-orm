import type { ColumnType } from "../decorators/Column";
import {
  EntityModel,
  ModelColumnField,
  ModelIndex,
  ModelRelationField,
} from "./EntityModel";
import {
  lit,
  noteLines,
  referentialActionEntries,
  relationColumnOptions,
} from "./emitSyntax";
import { fileBase } from "./lowering/Naming";

/**
 * Emits decorator-free entity source (`defineEntity` + the `t` field builders)
 * from an {@link EntityModel}.
 *
 * The output is the same schema the decorator emitter produces — `defineEntity`
 * funnels into the identical metadata bridge — spelled as plain values, so it
 * works without `experimentalDecorators` and infers its own row type.
 */
export class CodeFirstEmitter {
  constructor(private readonly importPath: string) {}

  emit(model: EntityModel): string {
    const hasRelations = model.fields.some((f) => f.kind === "manyToOne");

    const fieldLines: string[] = [];
    for (const field of model.fields) {
      const notes = [...(field.warnings ?? [])];
      if (field.kind === "column" && field.columnType === "blob" && !field.nullable && !field.primary) {
        // defineEntity() makes every blob column nullable and has no builder
        // to say otherwise.
        notes.push(
          "The database column is NOT NULL, but t.blob() columns are created nullable.",
        );
      }
      fieldLines.push(...noteLines(notes));
      fieldLines.push(
        ...(field.kind === "column"
          ? [`${field.propertyName}: ${columnChain(field)},`]
          : relationLines(field)),
      );
    }

    const imports = ["defineEntity", "t", "type InferEntity"];
    // Relation target thunks are annotated with `AnyEntityClass` so the
    // compiler stops inferring their return type — that is what lets two
    // entities (or an entity and itself) reference each other without
    // TS7022 "referenced directly or indirectly in its own initializer".
    if (hasRelations) imports.push("type AnyEntityClass");

    const lines: string[] = [];
    lines.push(`import { ${imports.join(", ")} } from ${lit(this.importPath)};`);
    for (const refClass of model.referencedClasses) {
      lines.push(`import { ${refClass} } from ${lit(`./${fileBase(refClass)}.js`)};`);
    }
    lines.push("");
    lines.push(...noteLines(model.notes));

    const options = entityOptions(model.classIndexes);
    lines.push(`export const ${model.className} = defineEntity(`);
    lines.push(`  ${lit(model.tableName)},`);
    lines.push("  {");
    lines.push(...fieldLines.map((l) => `    ${l}`));
    lines.push("  },");
    if (options) lines.push(...options.map((l) => `  ${l}`));
    lines.push(");");
    lines.push("");
    // Interface merging (not a type alias): interfaces resolve their members
    // lazily, which is what keeps a self-referencing entity from becoming a
    // circular type.
    lines.push(
      `export interface ${model.className} extends InferEntity<typeof ${model.className}> {}`,
    );
    lines.push("");
    return lines.join("\n");
  }
}

/** Renders the third `defineEntity` argument, or null when it would be empty. */
function entityOptions(indexes: ModelIndex[]): string[] | null {
  const unique = indexes.filter((i) => i.unique);
  const plain = indexes.filter((i) => !i.unique);
  if (unique.length === 0 && plain.length === 0) return null;

  const lines: string[] = ["{"];
  const render = (key: string, list: ModelIndex[]) => {
    lines.push(`  ${key}: [`);
    for (const idx of list) {
      const cols = idx.columns.map(lit).join(", ");
      const name = idx.name ? `, name: ${lit(idx.name)}` : "";
      lines.push(`    { columns: [${cols}]${name} },`);
    }
    lines.push("  ],");
  };
  if (unique.length > 0) render("uniqueIndexes", unique);
  if (plain.length > 0) render("indexes", plain);
  lines.push("},");
  return lines;
}

/** The `t.*` factory call for a column's type. */
function baseBuilder(field: ModelColumnField): string {
  const type: ColumnType = field.columnType;
  switch (type) {
    case "varchar":
    case "char":
      return field.length !== undefined ? `t.${type}(${field.length})` : `t.${type}()`;
    case "enum":
      return `t.enum([${(field.enumValues ?? []).map(lit).join(", ")}])`;
    case "array":
      return field.arrayElementType !== undefined
        ? `t.array(${lit(field.arrayElementType)})`
        : "t.array()";
    case "int":
    case "bigint":
    case "float":
    case "double":
    case "number":
    case "boolean":
    case "text":
    case "longtext":
    case "uuid":
    case "blob":
    case "json":
    case "jsonb":
    case "date":
    case "datetime":
    case "timestamp":
    case "timestamptz":
      return `t.${type}()`;
    default:
      // The lowering only picks built-in types; an unknown one would be a bug.
      throw new Error(`No t.* builder for column type "${String(type)}"`);
  }
}

function columnChain(field: ModelColumnField): string {
  const parts: string[] = [baseBuilder(field)];

  if (field.needsNameOption) parts.push(`name(${lit(field.columnName)})`);
  // varchar / char carry their length in the factory call.
  if (
    field.length !== undefined &&
    field.columnType !== "varchar" &&
    field.columnType !== "char"
  ) {
    parts.push(`length(${field.length})`);
  }
  if (field.precision !== undefined) {
    parts.push(`precision(${field.precision})`);
    if (field.scale !== undefined) parts.push(`scale(${field.scale})`);
  }
  if (field.enumName !== undefined) parts.push(`enumName(${lit(field.enumName)})`);
  if (field.primary) parts.push("primary()");
  if (field.generated) parts.push("generated()");
  if (field.timestamp === "create") parts.push("createTimestamp()");
  if (field.timestamp === "update") parts.push("updateTimestamp()");
  // `.deletedAt()` already implies nullable.
  if (field.timestamp === "deletedAt") parts.push("deletedAt()");
  else if (field.nullable) parts.push("nullable()");
  if (field.defaultLiteral !== undefined) {
    parts.push(`default(${field.defaultLiteral})`);
  }
  if (field.index) parts.push("index()");

  return parts.join(".");
}

/** The lines of one relation field, at zero indentation. */
function relationLines(field: ModelRelationField): string[] {
  // A self-referencing entity cannot also name its own row type as the
  // relation's shape — that reintroduces the very cycle the annotated thunk
  // breaks — so the shape parameter is omitted on that one form.
  const shape = field.selfReference ? "" : `<${field.targetClass}>`;
  return [
    `${field.propertyName}: t.manyToOne${shape}((): AnyEntityClass => ${field.targetClass}, {`,
    `  relationColumn: ${relationColumnOptions(field)},`,
    ...referentialActionEntries(field).map((entry) => `  ${entry},`),
    "}),",
  ];
}
