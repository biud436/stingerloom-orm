import {
  EntityModel,
  ModelColumnField,
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
 * Emits decorator-based entity source (`@Entity`, `@Column`, `@ManyToOne`, …)
 * from an {@link EntityModel}.
 *
 * Every option the model sets is written out, including the ones a decorator
 * would otherwise infer from the property's TypeScript type — decorator
 * metadata depends on the compiler settings (`string | null` is `Object`
 * under `strictNullChecks`, `String` without), and an inferred length or
 * nullability would make the column depend on them.
 */
export class DecoratorEmitter {
  constructor(private readonly importPath: string) {}

  emit(model: EntityModel): string {
    const usedDecorators = new Set<string>(["Entity"]);
    const propertyBlocks: string[] = [];
    let usesRelation = false;

    for (const field of model.fields) {
      if (field.kind === "column") {
        propertyBlocks.push(this.emitColumn(field, usedDecorators));
      } else {
        usesRelation = true;
        propertyBlocks.push(this.emitRelation(field, usedDecorators));
      }
    }

    const classDecorators: string[] = [];
    for (const idx of model.classIndexes) {
      const cols = idx.columns.map(lit).join(", ");
      const nameArg = idx.name ? `, ${lit(idx.name)}` : "";
      const decorator = idx.unique ? "UniqueIndex" : "Index";
      usedDecorators.add(decorator);
      classDecorators.push(`@${decorator}([${cols}]${nameArg})`);
    }

    const typeImports = usesRelation ? ["type Relation"] : [];
    const lines: string[] = [];
    lines.push(
      `import { ${[...Array.from(usedDecorators).sort(), ...typeImports].join(", ")} } from ${lit(this.importPath)};`,
    );
    for (const refClass of model.referencedClasses) {
      lines.push(`import { ${refClass} } from ${lit(`./${fileBase(refClass)}.js`)};`);
    }
    lines.push("");
    lines.push(...noteLines(model.notes));
    lines.push(`@Entity({ name: ${lit(model.tableName)} })`);
    lines.push(...classDecorators);
    lines.push(`export class ${model.className} {`);
    lines.push(propertyBlocks.join("\n\n"));
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  }

  private emitColumn(
    field: ModelColumnField,
    usedDecorators: Set<string>,
  ): string {
    const lines = noteLines(field.warnings, "  ");

    if (field.primary && field.generated) {
      usedDecorators.add("PrimaryGeneratedColumn");
      // `int` is the decorator's own default type.
      const opts: string[] = [];
      if (field.columnType !== "int") opts.push(`type: ${lit(field.columnType)}`);
      if (field.needsNameOption) opts.push(`name: ${lit(field.columnName)}`);
      lines.push(`  @PrimaryGeneratedColumn(${opts.length ? `{ ${opts.join(", ")} }` : ""})`);
    } else if (field.primary) {
      usedDecorators.add("PrimaryColumn");
      lines.push(`  @PrimaryColumn({ ${this.columnOptions(field, false).join(", ")} })`);
    } else if (field.timestamp) {
      const decorator = TIMESTAMP_DECORATORS[field.timestamp];
      usedDecorators.add(decorator);
      const opts: string[] = [];
      if (field.columnType !== "datetime") opts.push(`type: ${lit(field.columnType)}`);
      if (field.needsNameOption) opts.push(`name: ${lit(field.columnName)}`);
      lines.push(`  @${decorator}(${opts.length ? `{ ${opts.join(", ")} }` : ""})`);
    } else {
      usedDecorators.add("Column");
      lines.push(`  @Column({ ${this.columnOptions(field, true).join(", ")} })`);
    }

    if (field.index) {
      usedDecorators.add("Index");
      lines.push("  @Index()");
    }

    lines.push(`  ${field.propertyName}!: ${field.tsType};`);
    return lines.join("\n");
  }

  private columnOptions(field: ModelColumnField, withNullability: boolean): string[] {
    const opts: string[] = [`type: ${lit(field.columnType)}`];
    if (field.needsNameOption) opts.push(`name: ${lit(field.columnName)}`);
    if (field.length !== undefined) opts.push(`length: ${field.length}`);
    if (field.precision !== undefined) {
      opts.push(`precision: ${field.precision}`);
      if (field.scale !== undefined) opts.push(`scale: ${field.scale}`);
    }
    if (field.enumValues && field.enumValues.length > 0) {
      opts.push(`enumValues: [${field.enumValues.map(lit).join(", ")}]`);
    }
    if (field.enumName !== undefined) opts.push(`enumName: ${lit(field.enumName)}`);
    if (field.arrayElementType !== undefined) {
      opts.push(`arrayElementType: ${lit(field.arrayElementType)}`);
    }
    if (withNullability) {
      if (field.nullable) {
        opts.push("nullable: true");
      } else if (DESIGN_TYPES_DEFAULTING_TO_NULL.has(field.tsType)) {
        // `@Column` defaults these property types to nullable.
        opts.push("nullable: false");
      }
    }
    if (field.defaultLiteral !== undefined) {
      opts.push(`default: ${field.defaultLiteral}`);
    }
    return opts;
  }

  private emitRelation(
    field: ModelRelationField,
    usedDecorators: Set<string>,
  ): string {
    usedDecorators.add("ManyToOne");
    usedDecorators.add("RelationColumn");

    const lines = noteLines(field.warnings, "  ");

    // The inverse-side accessor cannot be known without reading the referenced
    // entity, so this is a placeholder to be renamed once both sides exist.
    //
    // `Relation<X>` keeps design:type from referencing the entity class
    // eagerly — circular FK schemas would otherwise throw a TDZ
    // ReferenceError at import time under ESM.
    const actions = referentialActionEntries(field);
    const optionsArg = actions.length > 0 ? `, { ${actions.join(", ")} }` : "";
    lines.push(
      `  @ManyToOne(() => ${field.targetClass}, (entity: any) => entity.${field.propertyName}${optionsArg})`,
    );
    lines.push(`  @RelationColumn(${relationColumnOptions(field)})`);
    lines.push(`  ${field.propertyName}!: Relation<${field.targetClass}>;`);
    return lines.join("\n");
  }
}

const TIMESTAMP_DECORATORS = {
  create: "CreateTimestamp",
  update: "UpdateTimestamp",
  deletedAt: "DeletedAt",
} as const;

/**
 * Property types whose `design:type` (`Object`, `Buffer`) makes `@Column`
 * default the column to nullable, so NOT NULL has to be written out.
 */
const DESIGN_TYPES_DEFAULTING_TO_NULL = new Set(["any", "Buffer"]);
