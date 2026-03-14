/* eslint-disable @typescript-eslint/no-explicit-any */
import { NativeTypeHint } from "./TypeMapper";

// ─── Intermediate Representation Types ───

export interface PrismaImportContext {
  provider: string;
  models: PrismaModelInfo[];
  enums: PrismaEnumInfo[];
}

export interface PrismaModelInfo {
  name: string;
  tableName?: string; // @@map
  fields: PrismaFieldInfo[];
  compositeId?: string[]; // @@id([...])
  uniqueConstraints: string[][]; // @@unique([...])
  indexes: string[][]; // @@index([...])
}

export interface PrismaFieldInfo {
  name: string;
  fieldType: string; // Prisma type name (String, Int, ModelName, EnumName...)
  isArray: boolean;
  isOptional: boolean;
  isId: boolean; // @id
  isUnique: boolean; // @unique
  isUpdatedAt: boolean; // @updatedAt
  columnName?: string; // @map("...")
  nativeType?: NativeTypeHint; // @db.*
  defaultValue?: PrismaDefaultValue;
  relation?: PrismaRelationInfo;
}

export type PrismaDefaultValue =
  | { kind: "function"; name: string }
  | { kind: "literal"; value: string | number | boolean };

export interface PrismaRelationInfo {
  name?: string; // @relation("name")
  fields?: string[]; // fields: [...]
  references?: string[]; // references: [...]
  onDelete?: string;
  onUpdate?: string;
}

export interface PrismaEnumInfo {
  name: string;
  dbName?: string; // @@map
  values: string[];
}

/**
 * Analyzes a Prisma AST and produces a structured PrismaImportContext.
 */
export class PrismaSchemaAnalyzer {
  analyze(ast: any): PrismaImportContext {
    const list: any[] = ast.list || [];

    const provider = this.extractProvider(list);
    const enums = this.extractEnums(list);
    const models = this.extractModels(list);

    return { provider, models, enums };
  }

  private extractProvider(list: any[]): string {
    const ds = list.find((n: any) => n.type === "datasource");
    if (!ds) return "postgresql";

    const providerAssign = ds.assignments?.find(
      (a: any) => a.key === "provider",
    );
    if (!providerAssign) return "postgresql";

    const val = String(providerAssign.value).replace(/"/g, "");
    // Normalize common provider names
    if (val === "postgres" || val === "postgresql") return "postgresql";
    if (val === "mysql") return "mysql";
    if (val === "sqlite") return "sqlite";
    return val;
  }

  private extractEnums(list: any[]): PrismaEnumInfo[] {
    return list
      .filter((n: any) => n.type === "enum")
      .map((e: any) => {
        const values = (e.enumerators || [])
          .filter((v: any) => v.type === "enumerator")
          .map((v: any) => v.name as string);

        // Check for @@map on enum
        const mapAttr = (e.enumerators || []).find(
          (v: any) => v.type === "attribute" && v.name === "map",
        );
        const dbName = mapAttr ? this.extractStringArg(mapAttr) : undefined;

        return { name: e.name, dbName, values };
      });
  }

  private extractModels(list: any[]): PrismaModelInfo[] {
    return list
      .filter((n: any) => n.type === "model")
      .map((m: any) => this.analyzeModel(m));
  }

  private analyzeModel(model: any): PrismaModelInfo {
    const properties: any[] = model.properties || [];

    const fields = properties
      .filter((p: any) => p.type === "field")
      .map((f: any) => this.analyzeField(f));

    // Model-level attributes
    const modelAttrs = properties.filter(
      (p: any) => p.type === "attribute" && p.kind === "object",
    );

    const tableName = this.extractModelMap(modelAttrs);
    const compositeId = this.extractCompositeId(modelAttrs);
    const uniqueConstraints = this.extractArrayAttributes(modelAttrs, "unique");
    const indexes = this.extractArrayAttributes(modelAttrs, "index");

    return {
      name: model.name,
      tableName,
      fields,
      compositeId,
      uniqueConstraints,
      indexes,
    };
  }

  private analyzeField(field: any): PrismaFieldInfo {
    const attrs: any[] = field.attributes || [];

    const info: PrismaFieldInfo = {
      name: field.name,
      fieldType: field.fieldType,
      isArray: !!field.array,
      isOptional: !!field.optional,
      isId: attrs.some((a: any) => a.name === "id" && !a.group),
      isUnique: attrs.some((a: any) => a.name === "unique" && !a.group),
      isUpdatedAt: attrs.some((a: any) => a.name === "updatedAt" && !a.group),
    };

    // @map("column_name")
    const mapAttr = attrs.find(
      (a: any) => a.name === "map" && !a.group,
    );
    if (mapAttr) {
      info.columnName = this.extractStringArg(mapAttr);
    }

    // @db.* native type hint
    const dbAttr = attrs.find((a: any) => a.group === "db");
    if (dbAttr) {
      info.nativeType = {
        name: dbAttr.name,
        args: (dbAttr.args || []).map((a: any) => {
          const val = a.value ?? a;
          return typeof val === "string" && /^\d+$/.test(val)
            ? parseInt(val, 10)
            : val;
        }),
      };
    }

    // @default(...)
    const defaultAttr = attrs.find(
      (a: any) => a.name === "default" && !a.group,
    );
    if (defaultAttr) {
      info.defaultValue = this.extractDefault(defaultAttr);
    }

    // @relation(...)
    const relationAttr = attrs.find(
      (a: any) => a.name === "relation" && !a.group,
    );
    if (relationAttr) {
      info.relation = this.extractRelation(relationAttr);
    }

    return info;
  }

  private extractDefault(attr: any): PrismaDefaultValue | undefined {
    const args: any[] = attr.args || [];
    if (args.length === 0) return undefined;

    const val = args[0].value;

    if (typeof val === "object" && val?.type === "function") {
      return { kind: "function", name: val.name };
    }

    // Literal value
    const raw = String(val);
    if (raw === "true") return { kind: "literal", value: true };
    if (raw === "false") return { kind: "literal", value: false };
    if (/^-?\d+(\.\d+)?$/.test(raw))
      return { kind: "literal", value: parseFloat(raw) };

    // String literal (may be quoted in the AST)
    const unquoted = raw.replace(/^"|"$/g, "");
    return { kind: "literal", value: unquoted };
  }

  private extractRelation(attr: any): PrismaRelationInfo {
    const args: any[] = attr.args || [];
    const rel: PrismaRelationInfo = {};

    for (const arg of args) {
      const val = arg.value;

      if (typeof val === "string") {
        // Positional string arg = relation name
        rel.name = val.replace(/^"|"$/g, "");
        continue;
      }

      if (typeof val === "object" && val?.type === "keyValue") {
        const key = val.key;
        if (key === "fields" && val.value?.type === "array") {
          rel.fields = val.value.args as string[];
        } else if (key === "references" && val.value?.type === "array") {
          rel.references = val.value.args as string[];
        } else if (key === "onDelete") {
          rel.onDelete = String(val.value);
        } else if (key === "onUpdate") {
          rel.onUpdate = String(val.value);
        } else if (key === "name") {
          rel.name = String(val.value).replace(/^"|"$/g, "");
        }
      }
    }

    return rel;
  }

  private extractModelMap(attrs: any[]): string | undefined {
    const mapAttr = attrs.find((a: any) => a.name === "map");
    return mapAttr ? this.extractStringArg(mapAttr) : undefined;
  }

  private extractCompositeId(attrs: any[]): string[] | undefined {
    const idAttr = attrs.find((a: any) => a.name === "id");
    if (!idAttr) return undefined;
    return this.extractArrayArg(idAttr);
  }

  private extractArrayAttributes(
    attrs: any[],
    name: string,
  ): string[][] {
    return attrs
      .filter((a: any) => a.name === name)
      .map((a: any) => this.extractArrayArg(a))
      .filter((arr): arr is string[] => arr !== undefined);
  }

  private extractStringArg(attr: any): string | undefined {
    const args: any[] = attr.args || [];
    if (args.length === 0) return undefined;
    const raw = String(args[0].value);
    return raw.replace(/^"|"$/g, "");
  }

  private extractArrayArg(attr: any): string[] | undefined {
    const args: any[] = attr.args || [];
    if (args.length === 0) return undefined;
    const val = args[0].value;
    if (typeof val === "object" && val?.type === "array") {
      return val.args as string[];
    }
    return undefined;
  }
}
