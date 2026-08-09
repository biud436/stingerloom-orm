import {
  PrismaImportContext,
  PrismaModelInfo,
  PrismaFieldInfo,
  PrismaEnumInfo,
} from "./PrismaSchemaAnalyzer";
import { ResolvedRelation } from "./RelationResolver";
import { TypeMapper, TypeMappingResult } from "./TypeMapper";
import { camelToSnakeCase } from "../../utils/camelToSnakeCase";

/**
 * Generates TypeScript entity source code from analyzed Prisma models.
 */
export class EntityCodeGenerator {
  private typeMapper: TypeMapper;
  private modelNames: Set<string>;
  private enumNames: Set<string>;

  private enumDbNameMap: Map<string, string>; // logical name → dbName

  constructor(
    private context: PrismaImportContext,
    private relations: Map<string, ResolvedRelation[]>,
  ) {
    const enumMap = new Map<string, string[]>();
    this.enumDbNameMap = new Map<string, string>();
    for (const e of context.enums) {
      enumMap.set(e.name, e.values);
      if (e.dbName) {
        this.enumDbNameMap.set(e.name, e.dbName);
      }
    }
    this.typeMapper = new TypeMapper(context.provider, enumMap);
    this.modelNames = new Set(context.models.map((m) => m.name));
    this.enumNames = new Set(context.enums.map((e) => e.name));
  }

  /**
   * Generate all files: entities + enums + barrel index.
   * Returns a Map<filename, source>.
   */
  generateAll(): Map<string, string> {
    const files = new Map<string, string>();

    // Generate enum files
    for (const enumInfo of this.context.enums) {
      const fileName = `${camelToSnakeCase(enumInfo.name)}.enum.ts`;
      files.set(fileName, this.generateEnum(enumInfo));
    }

    // Generate entity files
    for (const model of this.context.models) {
      const fileName = `${camelToSnakeCase(model.name)}.entity.ts`;
      const relations = this.relations.get(model.name) || [];
      files.set(fileName, this.generateEntity(model, relations));
    }

    // Generate barrel index
    files.set("index.ts", this.generateBarrel(files));

    return files;
  }

  private generateEnum(enumInfo: PrismaEnumInfo): string {
    const lines: string[] = [];
    lines.push(`export enum ${enumInfo.name} {`);
    for (const value of enumInfo.values) {
      lines.push(`  ${value} = "${value}",`);
    }
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  }

  private generateEntity(
    model: PrismaModelInfo,
    relations: ResolvedRelation[],
  ): string {
    const imports = new ImportCollector();
    const bodyLines: string[] = [];
    const classDecorators: string[] = [];

    // Determine which fields are FK columns used in relations (skip them as columns)
    const fkFields = this.collectFkFields(model);

    // @@map → @Entity({ name: "..." })
    if (model.tableName) {
      classDecorators.push(`@Entity({ name: "${model.tableName}" })`);
      imports.addOrm("Entity");
    } else {
      classDecorators.push("@Entity()");
      imports.addOrm("Entity");
    }

    // @@unique → @UniqueIndex
    for (const cols of model.uniqueConstraints) {
      classDecorators.push(
        `@UniqueIndex([${cols.map((c) => `"${c}"`).join(", ")}])`,
      );
      imports.addOrm("UniqueIndex");
    }

    // @@index → @Index
    for (const cols of model.indexes) {
      classDecorators.push(
        `@Index([${cols.map((c) => `"${c}"`).join(", ")}])`,
      );
      imports.addOrm("Index");
    }

    // Process fields (also collect field-level @unique for class decorators)
    const fieldUniqueColumns: string[] = [];
    for (const field of model.fields) {
      // Skip relation fields (they're handled separately)
      if (this.isRelationField(field)) continue;

      // Skip FK fields that are handled by relation decorators
      if (fkFields.has(field.name)) continue;

      // Collect field-level @unique (not PK, not relation, not FK)
      if (field.isUnique && !field.isId && !model.compositeId?.includes(field.name)) {
        fieldUniqueColumns.push(field.columnName ?? field.name);
      }

      const fieldLines = this.generateColumnField(
        model,
        field,
        imports,
      );
      bodyLines.push(...fieldLines);
    }

    // Emit field-level @unique as class-level @UniqueIndex
    for (const col of fieldUniqueColumns) {
      classDecorators.push(`@UniqueIndex(["${col}"])`);
      imports.addOrm("UniqueIndex");
    }

    // Process relations
    for (const rel of relations) {
      const fieldLines = this.generateRelationField(rel, imports);
      bodyLines.push(...fieldLines);
    }

    // Assemble file
    const sections: string[] = [];

    // ORM imports
    const ormImports = imports.getOrmImports();
    if (ormImports.length > 0) {
      sections.push(
        `import { ${ormImports.join(", ")} } from "@stingerloom/orm";`,
      );
    }

    // Entity imports (cross-entity references). The explicit `.js` extension
    // keeps the generated code loadable from ESM projects (NodeNext requires
    // it); TypeScript maps `./x.js` back to `./x.ts` under every module
    // resolution mode, so CJS projects compile unchanged.
    for (const [entityName, fileName] of imports.getEntityImports()) {
      sections.push(
        `import { ${entityName} } from "./${fileName}.js";`,
      );
    }

    // Enum imports
    for (const [enumName, fileName] of imports.getEnumImports()) {
      sections.push(
        `import { ${enumName} } from "./${fileName}.js";`,
      );
    }

    sections.push("");

    // Class decorators + class declaration
    for (const dec of classDecorators) {
      sections.push(dec);
    }
    sections.push(`export class ${model.name} {`);
    // Each field generator appends a blank separator line; drop the trailing
    // one so the class body does not end with a stray empty line.
    const body = [...bodyLines];
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    sections.push(body.join("\n"));
    sections.push("}");
    sections.push("");

    return sections.join("\n");
  }

  private generateColumnField(
    model: PrismaModelInfo,
    field: PrismaFieldInfo,
    imports: ImportCollector,
  ): string[] {
    const lines: string[] = [];

    // Determine if this is a PK
    const isId = field.isId || model.compositeId?.includes(field.name);
    const isAutoIncrement =
      field.defaultValue?.kind === "function" &&
      field.defaultValue.name === "autoincrement";
    const isNow =
      field.defaultValue?.kind === "function" &&
      field.defaultValue.name === "now";
    const isUuid =
      field.defaultValue?.kind === "function" &&
      field.defaultValue.name === "uuid";
    const isCuid =
      field.defaultValue?.kind === "function" &&
      field.defaultValue.name === "cuid";

    if (isId && isAutoIncrement) {
      // @PrimaryGeneratedColumn()
      imports.addOrm("PrimaryGeneratedColumn");
      lines.push("  @PrimaryGeneratedColumn()");
      lines.push(`  ${field.name}!: number;`);
      lines.push("");
      return lines;
    }

    if (isId && isUuid) {
      // @default(uuid()) → UUIDv4 generation, same semantics as Prisma
      imports.addOrm("PrimaryGeneratedColumn");
      lines.push(`  @PrimaryGeneratedColumn("uuid")`);
      lines.push(`  ${field.name}!: string;`);
      lines.push("");
      return lines;
    }

    if (isId && isCuid) {
      // cuid has no ORM generation strategy — keep the varchar PK but say so
      // explicitly instead of importing an entity that silently never
      // generates its id.
      imports.addOrm("PrimaryColumn");
      lines.push(
        `  // NOTE: Prisma @default(cuid()) has no Stingerloom equivalent — assign the id in application code (e.g. @paralleldrive/cuid2) before insert, or switch to @PrimaryGeneratedColumn("uuid").`,
      );
      lines.push(`  @PrimaryColumn({ type: "varchar", length: 36 })`);
      lines.push(`  ${field.name}!: string;`);
      lines.push("");
      return lines;
    }

    if (isId && model.compositeId) {
      // Composite PK
      imports.addOrm("PrimaryColumn");
      const mapping = this.typeMapper.map(field.fieldType, field.nativeType);
      const opts = this.buildColumnOptions(field, mapping, false);
      if (opts) {
        lines.push(`  @PrimaryColumn(${opts})`);
      } else {
        lines.push("  @PrimaryColumn()");
      }
      lines.push(`  ${field.name}!: ${this.tsType(field, mapping)};`);
      lines.push("");
      return lines;
    }

    if (isId) {
      // Simple @id without autoincrement
      imports.addOrm("PrimaryColumn");
      const mapping = this.typeMapper.map(field.fieldType, field.nativeType);
      const opts = this.buildColumnOptions(field, mapping, false);
      if (opts) {
        lines.push(`  @PrimaryColumn(${opts})`);
      } else {
        lines.push("  @PrimaryColumn()");
      }
      lines.push(`  ${field.name}!: ${this.tsType(field, mapping)};`);
      lines.push("");
      return lines;
    }

    // @updatedAt → @UpdateTimestamp()
    if (field.isUpdatedAt) {
      imports.addOrm("UpdateTimestamp");
      lines.push("  @UpdateTimestamp()");
      lines.push(`  ${field.name}!: Date;`);
      lines.push("");
      return lines;
    }

    // @default(now()) → @CreateTimestamp()
    if (isNow) {
      imports.addOrm("CreateTimestamp");
      lines.push("  @CreateTimestamp()");
      lines.push(`  ${field.name}!: Date;`);
      lines.push("");
      return lines;
    }

    // Regular column
    const mapping = this.typeMapper.map(field.fieldType, field.nativeType);

    // Enum import
    if (mapping.enumName && this.enumNames.has(mapping.enumName)) {
      imports.addEnum(
        mapping.enumName,
        camelToSnakeCase(mapping.enumName) + ".enum",
      );
    }

    // Function defaults other than now()/autoincrement (uuid, cuid,
    // dbgenerated, ...) have no column-level mapping — surface that in the
    // generated code instead of dropping the default silently.
    if (field.defaultValue?.kind === "function") {
      lines.push(
        `  // NOTE: Prisma @default(${field.defaultValue.name}()) is not mapped — assign the value in application code or add a database default manually.`,
      );
    }

    imports.addOrm("Column");
    const opts = this.buildColumnOptions(field, mapping, true);
    if (opts) {
      lines.push(`  @Column(${opts})`);
    } else {
      lines.push("  @Column()");
    }

    lines.push(`  ${field.name}!: ${this.tsType(field, mapping)};`);
    lines.push("");
    return lines;
  }

  private generateRelationField(
    rel: ResolvedRelation,
    imports: ImportCollector,
  ): string[] {
    const lines: string[] = [];

    switch (rel.kind) {
      case "ManyToOne": {
        imports.addOrm("ManyToOne");
        imports.addEntity(
          rel.targetModel,
          camelToSnakeCase(rel.targetModel) + ".entity",
        );
        const opts: string[] = [];
        if (rel.references) opts.push(`references: "${rel.references}"`);
        if (rel.cascade)
          opts.push(
            `cascade: [${rel.cascade.map((c) => `"${c}"`).join(", ")}]`,
          );
        if (rel.onDelete) opts.push(`onDelete: "${rel.onDelete}"`);
        if (rel.onUpdate) opts.push(`onUpdate: "${rel.onUpdate}"`);
        const optsStr = opts.length > 0 ? `, { ${opts.join(", ")} }` : "";
        lines.push(
          `  @ManyToOne(() => ${rel.targetModel}, (e) => e.${this.findInverseProperty(rel.targetModel, rel.propertyName)}${optsStr})`,
        );
        if (rel.joinColumn) {
          imports.addOrm("RelationColumn");
          lines.push(`  @RelationColumn({ name: "${rel.joinColumn}" })`);
        }
        lines.push(`  ${rel.propertyName}!: ${rel.targetModel};`);
        lines.push("");
        break;
      }

      case "OneToMany": {
        imports.addOrm("OneToMany");
        imports.addEntity(
          rel.targetModel,
          camelToSnakeCase(rel.targetModel) + ".entity",
        );
        lines.push(
          `  @OneToMany(() => ${rel.targetModel}, { mappedBy: "${rel.mappedBy}" })`,
        );
        lines.push(`  ${rel.propertyName}!: ${rel.targetModel}[];`);
        lines.push("");
        break;
      }

      case "OneToOneOwning": {
        imports.addOrm("OneToOne");
        imports.addEntity(
          rel.targetModel,
          camelToSnakeCase(rel.targetModel) + ".entity",
        );
        const opts: string[] = [];
        if (rel.cascade)
          opts.push(
            `cascade: [${rel.cascade.map((c) => `"${c}"`).join(", ")}]`,
          );
        if (rel.onDelete) opts.push(`onDelete: "${rel.onDelete}"`);
        if (rel.onUpdate) opts.push(`onUpdate: "${rel.onUpdate}"`);
        const optsStr = opts.length > 0 ? `{ ${opts.join(", ")} }` : "";
        lines.push(
          `  @OneToOne(() => ${rel.targetModel}${optsStr ? ", " + optsStr : ""})`,
        );
        if (rel.joinColumn) {
          imports.addOrm("RelationColumn");
          lines.push(`  @RelationColumn({ name: "${rel.joinColumn}" })`);
        }
        lines.push(`  ${rel.propertyName}!: ${rel.targetModel};`);
        lines.push("");
        break;
      }

      case "OneToOneInverse": {
        imports.addOrm("OneToOne");
        imports.addEntity(
          rel.targetModel,
          camelToSnakeCase(rel.targetModel) + ".entity",
        );
        lines.push(
          `  @OneToOne(() => ${rel.targetModel}, { inverseSide: "${rel.inverseSide}" })`,
        );
        lines.push(`  ${rel.propertyName}!: ${rel.targetModel};`);
        lines.push("");
        break;
      }

      case "ManyToManyOwning": {
        imports.addOrm("ManyToMany");
        imports.addEntity(
          rel.targetModel,
          camelToSnakeCase(rel.targetModel) + ".entity",
        );
        lines.push(`  @ManyToMany(() => ${rel.targetModel}, {`);
        lines.push(`    joinTable: {`);
        lines.push(`      name: "${rel.joinTableName}",`);
        lines.push(`      joinColumn: "${rel.joinColumn}",`);
        lines.push(`      inverseJoinColumn: "${rel.inverseJoinColumn}",`);
        lines.push(`    },`);
        lines.push(`  })`);
        lines.push(`  ${rel.propertyName}!: ${rel.targetModel}[];`);
        lines.push("");
        break;
      }

      case "ManyToManyInverse": {
        imports.addOrm("ManyToMany");
        imports.addEntity(
          rel.targetModel,
          camelToSnakeCase(rel.targetModel) + ".entity",
        );
        lines.push(
          `  @ManyToMany(() => ${rel.targetModel}, { mappedBy: "${rel.mappedBy}" })`,
        );
        lines.push(`  ${rel.propertyName}!: ${rel.targetModel}[];`);
        lines.push("");
        break;
      }
    }

    return lines;
  }

  /**
   * Find inverse property name on target model for ManyToOne decorator.
   */
  private findInverseProperty(
    targetModelName: string,
    ownPropertyName: string,
  ): string {
    const rels = this.relations.get(targetModelName) || [];
    const inverse = rels.find(
      (r) =>
        r.kind === "OneToMany" &&
        r.targetModel ===
          this.findModelForProperty(ownPropertyName) &&
        r.mappedBy === ownPropertyName,
    );
    return inverse?.propertyName ?? ownPropertyName;
  }

  private findModelForProperty(propertyName: string): string {
    for (const [modelName, rels] of this.relations) {
      if (rels.some((r) => r.propertyName === propertyName)) {
        return modelName;
      }
    }
    return "";
  }

  private buildColumnOptions(
    field: PrismaFieldInfo,
    mapping: TypeMappingResult,
    includeDefault: boolean,
  ): string {
    const opts: string[] = [];

    // Type — only specify when not the default inference
    const needsExplicitType = this.needsExplicitType(field, mapping);
    if (needsExplicitType) {
      opts.push(`type: "${mapping.columnType}"`);
    }

    // Length
    if (mapping.length && mapping.length !== 255 && mapping.length !== 11) {
      opts.push(`length: ${mapping.length}`);
    }

    // Precision/Scale
    if (mapping.precision) opts.push(`precision: ${mapping.precision}`);
    if (mapping.scale) opts.push(`scale: ${mapping.scale}`);

    // Nullable
    if (field.isOptional) {
      opts.push("nullable: true");
    }

    // Column name (@map)
    if (field.columnName) {
      opts.push(`name: "${field.columnName}"`);
    }

    // Enum
    if (mapping.enumName) {
      const enumDbName = this.enumDbNameMap.get(mapping.enumName) ?? mapping.enumName;
      opts.push(`enumName: "${enumDbName}"`);
      opts.push(
        `enumValues: [${mapping.enumValues!.map((v) => `"${v}"`).join(", ")}]`,
      );
    }

    // Default value
    if (includeDefault && field.defaultValue?.kind === "literal") {
      const val = field.defaultValue.value;
      if (typeof val === "string") {
        opts.push(`default: "${val}"`);
      } else if (typeof val === "boolean") {
        opts.push(`default: ${val}`);
      } else if (typeof val === "number") {
        opts.push(`default: ${val}`);
      }
    }

    if (opts.length === 0) return "";
    return `{ ${opts.join(", ")} }`;
  }

  private needsExplicitType(
    field: PrismaFieldInfo,
    mapping: TypeMappingResult,
  ): boolean {
    // If it's an enum, always specify
    if (mapping.columnType === "enum") return true;

    // If the default inference from TS type would differ
    const defaultMapping: Record<string, string> = {
      String: "varchar",
      Int: "int",
      Boolean: "boolean",
      DateTime: "datetime",
      Float: "float",
    };

    const expected = defaultMapping[field.fieldType];
    if (!expected) return true;
    return expected !== mapping.columnType;
  }

  private tsType(
    field: PrismaFieldInfo,
    mapping: TypeMappingResult,
  ): string {
    if (field.isOptional) {
      return `${this.baseTsType(field, mapping)} | null`;
    }
    return this.baseTsType(field, mapping);
  }

  private baseTsType(
    field: PrismaFieldInfo,
    mapping: TypeMappingResult,
  ): string {
    switch (field.fieldType) {
      case "String":
        return "string";
      case "Int":
      case "Float":
      case "Decimal":
        return "number";
      case "BigInt":
        return "bigint";
      case "Boolean":
        return "boolean";
      case "DateTime":
        return "Date";
      case "Json":
        return "unknown";
      case "Bytes":
        return "Buffer";
      default:
        if (mapping.enumName) return "string";
        return "unknown";
    }
  }

  private isRelationField(field: PrismaFieldInfo): boolean {
    return this.modelNames.has(field.fieldType);
  }

  private collectFkFields(model: PrismaModelInfo): Set<string> {
    const fkFields = new Set<string>();
    for (const field of model.fields) {
      if (field.relation?.fields) {
        for (const fk of field.relation.fields) {
          fkFields.add(fk);
        }
      }
    }
    return fkFields;
  }

  private generateBarrel(files: Map<string, string>): string {
    const lines: string[] = [];
    for (const fileName of files.keys()) {
      if (fileName === "index.ts") continue;
      const moduleName = fileName.replace(/\.ts$/, "");
      lines.push(`export * from "./${moduleName}.js";`);
    }
    lines.push("");
    return lines.join("\n");
  }
}

/**
 * Collects import statements needed for an entity file.
 */
class ImportCollector {
  private ormImports = new Set<string>();
  private entityImports = new Map<string, string>(); // name → file
  private enumImports = new Map<string, string>(); // name → file

  addOrm(name: string): void {
    this.ormImports.add(name);
  }

  addEntity(name: string, file: string): void {
    this.entityImports.set(name, file);
  }

  addEnum(name: string, file: string): void {
    this.enumImports.set(name, file);
  }

  getOrmImports(): string[] {
    return [...this.ormImports].sort();
  }

  getEntityImports(): [string, string][] {
    return [...this.entityImports.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }

  getEnumImports(): [string, string][] {
    return [...this.enumImports.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }
}
