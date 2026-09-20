import { ColumnType } from "../decorators/Column";
import { fileBase, relationColumnOptions } from "./DecoratorEmitter";
import {
  EntityModel,
  ModelColumnField,
  ModelRelationField,
} from "./EntityModel";

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
      for (const warning of field.warnings ?? []) {
        fieldLines.push(`// NOTE: ${warning}`);
      }
      const source =
        field.kind === "column"
          ? [`${field.propertyName}: ${columnChain(field)},`]
          : relationLines(field);
      fieldLines.push(...source);
    }

    const imports = ["defineEntity", "t", "type InferEntity"];
    // Relation target thunks are annotated with `AnyEntityClass` so the
    // compiler stops inferring their return type — that is what lets two
    // entities (or an entity and itself) reference each other without
    // TS7022 "referenced directly or indirectly in its own initializer".
    if (hasRelations) imports.push("type AnyEntityClass");

    const lines: string[] = [];
    lines.push(`import { ${imports.join(", ")} } from "${this.importPath}";`);
    for (const refClass of model.referencedClasses) {
      lines.push(`import { ${refClass} } from "./${fileBase(refClass)}.js";`);
    }
    lines.push("");

    const options = entityOptions(model);
    lines.push(`export const ${model.className} = defineEntity(`);
    lines.push(`  ${JSON.stringify(model.tableName)},`);
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
function entityOptions(model: EntityModel): string[] | null {
  const unique = model.classIndexes.filter((i) => i.unique);
  const plain = model.classIndexes.filter((i) => !i.unique);
  if (unique.length === 0 && plain.length === 0) return null;

  const lines: string[] = ["{"];
  const render = (key: string, list: typeof model.classIndexes) => {
    lines.push(`  ${key}: [`);
    for (const idx of list) {
      const cols = idx.columns.map((c) => JSON.stringify(c)).join(", ");
      const name = idx.name ? `, name: ${JSON.stringify(idx.name)}` : "";
      lines.push(`    { columns: [${cols}]${name} },`);
    }
    lines.push("  ],");
  };
  if (unique.length > 0) render("uniqueIndexes", unique);
  if (plain.length > 0) render("indexes", plain);
  lines.push("},");
  return lines;
}

/**
 * Base `t.*` factory call for a column type. Falls back to `t.varchar()` for
 * anything without a builder of its own (the model already flags those).
 */
function baseBuilder(field: ModelColumnField): string {
  const type: ColumnType = field.columnType;
  switch (type) {
    case "varchar":
      return field.length !== undefined ? `t.varchar(${field.length})` : "t.varchar()";
    case "char":
      return field.length !== undefined ? `t.char(${field.length})` : "t.char()";
    case "enum":
      return field.enumValues && field.enumValues.length > 0
        ? `t.enum([${field.enumValues.map((v) => JSON.stringify(v)).join(", ")}])`
        : "t.varchar()";
    case "array":
      return "t.array()";
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
      return "t.varchar()";
  }
}

function columnChain(field: ModelColumnField): string {
  const parts: string[] = [baseBuilder(field)];

  if (field.needsNameOption) parts.push(`name(${JSON.stringify(field.columnName)})`);
  if (field.precision !== undefined) {
    parts.push(`precision(${field.precision})`);
    if (field.scale !== undefined) parts.push(`scale(${field.scale})`);
  }
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
    "}),",
  ];
}
