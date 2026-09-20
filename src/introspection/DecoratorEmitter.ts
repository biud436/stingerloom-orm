import {
  EntityModel,
  ModelColumnField,
  ModelRelationField,
} from "./EntityModel";

/**
 * Emits decorator-based entity source (`@Entity`, `@Column`, `@ManyToOne`, …)
 * from an {@link EntityModel}.
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
      const cols = idx.columns.map((c) => JSON.stringify(c)).join(", ");
      const nameArg = idx.name ? `, ${JSON.stringify(idx.name)}` : "";
      if (idx.unique) {
        usedDecorators.add("UniqueIndex");
        classDecorators.push(`@UniqueIndex([${cols}]${nameArg})`);
      } else {
        usedDecorators.add("Index");
        classDecorators.push(`@Index([${cols}]${nameArg})`);
      }
    }

    const typeImports = usesRelation ? ["type Relation"] : [];
    const lines: string[] = [];
    lines.push(
      `import { ${[...Array.from(usedDecorators).sort(), ...typeImports].join(", ")} } from "${this.importPath}";`,
    );
    for (const refClass of model.referencedClasses) {
      lines.push(
        `import { ${refClass} } from "./${fileBase(refClass)}.js";`,
      );
    }
    lines.push("");
    lines.push(`@Entity({ name: "${model.tableName}" })`);
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
    const lines: string[] = [];
    for (const warning of field.warnings ?? []) {
      lines.push(`  // NOTE: ${warning}`);
    }

    if (field.primary && field.generated) {
      usedDecorators.add("PrimaryGeneratedColumn");
      lines.push(
        field.needsNameOption
          ? `  @PrimaryGeneratedColumn({ name: "${field.columnName}" })`
          : "  @PrimaryGeneratedColumn()",
      );
    } else if (field.primary && field.fkPrimary) {
      // Pin the column name explicitly so the original (possibly snake_case)
      // name survives while the property stays camelCase.
      usedDecorators.add("PrimaryColumn");
      lines.push(
        `  @PrimaryColumn({ type: "${field.columnType}", name: "${field.columnName}" })`,
      );
    } else if (field.primary) {
      usedDecorators.add("PrimaryColumn");
      lines.push(
        field.needsNameOption
          ? `  @PrimaryColumn({ name: "${field.columnName}" })`
          : "  @PrimaryColumn()",
      );
    } else if (field.timestamp) {
      const decorator = TIMESTAMP_DECORATORS[field.timestamp];
      usedDecorators.add(decorator);
      const opts: string[] = [];
      if (field.columnType !== "datetime") opts.push(`type: "${field.columnType}"`);
      if (field.needsNameOption) opts.push(`name: "${field.columnName}"`);
      lines.push(`  @${decorator}(${opts.length ? `{ ${opts.join(", ")} }` : ""})`);
    } else {
      usedDecorators.add("Column");
      lines.push(`  @Column(${this.columnOptions(field)})`);
    }

    if (field.index) {
      usedDecorators.add("Index");
      lines.push("  @Index()");
    }

    lines.push(`  ${field.propertyName}!: ${field.tsType};`);
    return lines.join("\n");
  }

  private columnOptions(field: ModelColumnField): string {
    const opts: string[] = [`type: "${field.columnType}"`];
    if (field.needsNameOption) opts.push(`name: "${field.columnName}"`);
    if (field.length !== undefined) opts.push(`length: ${field.length}`);
    if (field.precision !== undefined) {
      opts.push(`precision: ${field.precision}`);
      if (field.scale !== undefined) opts.push(`scale: ${field.scale}`);
    }
    if (field.enumValues) {
      opts.push(
        `enum: [${field.enumValues.map((v) => JSON.stringify(v)).join(", ")}]`,
      );
    }
    if (field.nullable) opts.push("nullable: true");
    if (field.defaultLiteral !== undefined) {
      opts.push(`default: ${field.defaultLiteral}`);
    }
    return `{ ${opts.join(", ")} }`;
  }

  private emitRelation(
    field: ModelRelationField,
    usedDecorators: Set<string>,
  ): string {
    usedDecorators.add("ManyToOne");
    usedDecorators.add("RelationColumn");

    const lines: string[] = [];
    for (const warning of field.warnings ?? []) {
      lines.push(`  // NOTE: ${warning}`);
    }

    // The inverse-side accessor cannot be known without reading the referenced
    // entity, so this is a placeholder to be renamed once both sides exist.
    //
    // `Relation<X>` keeps design:type from referencing the entity class
    // eagerly — circular FK schemas would otherwise throw a TDZ
    // ReferenceError at import time under ESM.
    lines.push(
      `  @ManyToOne(() => ${field.targetClass}, (entity: any) => entity.${field.propertyName})`,
    );
    lines.push(`  @RelationColumn(${relationColumnOptions(field)})`);
    lines.push(
      `  ${field.propertyName}!: Relation<${field.targetClass}>;`,
    );
    return lines.join("\n");
  }
}

const TIMESTAMP_DECORATORS = {
  create: "CreateTimestamp",
  update: "UpdateTimestamp",
  deletedAt: "DeletedAt",
} as const;

/**
 * FK column options shared by both emitters. The type and nullability are
 * always written out: inferring them from the target's primary key loses a
 * `NOT NULL` and can widen or narrow the column.
 */
export function relationColumnOptions(field: ModelRelationField): string {
  const opts = [
    `name: "${field.fkColumn}"`,
    `type: "${field.fkType}"`,
    `nullable: ${field.fkNullable}`,
  ];
  if (field.referencedColumn) {
    opts.push(`referencedColumn: "${field.referencedColumn}"`);
  }
  return `{ ${opts.join(", ")} }`;
}

/** `UserProfile` → `user-profile.entity` (the relative import specifier). */
export function fileBase(className: string): string {
  return (
    className
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase() + ".entity"
  );
}
