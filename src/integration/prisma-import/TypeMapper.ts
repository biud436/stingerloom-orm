import { ColumnType } from "../../decorators/Column";

/**
 * Prisma native type hint parsed from @db.* attributes.
 */
export interface NativeTypeHint {
  name: string;
  args: (string | number)[];
}

/**
 * Result of mapping a Prisma field type to stingerloom ColumnType.
 */
export interface TypeMappingResult {
  columnType: ColumnType;
  length?: number;
  precision?: number;
  scale?: number;
  enumName?: string;
  enumValues?: string[];
}

/**
 * Maps Prisma schema types to stingerloom ORM ColumnType values.
 */
export class TypeMapper {
  private readonly provider: string;
  private readonly enumMap: Map<string, string[]>;

  constructor(provider: string, enumMap: Map<string, string[]>) {
    this.provider = provider;
    this.enumMap = enumMap;
  }

  /**
   * Map a Prisma type + optional @db.* hint to a stingerloom ColumnType.
   */
  map(
    prismaType: string,
    nativeHint?: NativeTypeHint,
  ): TypeMappingResult {
    // Check if it's an enum reference
    if (this.enumMap.has(prismaType)) {
      return {
        columnType: "enum",
        enumName: prismaType,
        enumValues: this.enumMap.get(prismaType)!,
      };
    }

    // Handle native type hints first
    if (nativeHint) {
      return this.mapWithNativeHint(prismaType, nativeHint);
    }

    return this.mapBaseType(prismaType);
  }

  private mapBaseType(prismaType: string): TypeMappingResult {
    switch (prismaType) {
      case "String":
        return { columnType: "varchar", length: 255 };
      case "Boolean":
        return { columnType: "boolean" };
      case "Int":
        return { columnType: "int" };
      case "BigInt":
        return { columnType: "bigint" };
      case "Float":
        return { columnType: "float" };
      case "Decimal":
        return { columnType: "double" };
      case "DateTime":
        return { columnType: "datetime" };
      case "Json":
        return {
          columnType: this.provider === "postgresql" ? "jsonb" : "json",
        };
      case "Bytes":
        return { columnType: "blob" };
      default:
        return { columnType: "text" };
    }
  }

  private mapWithNativeHint(
    prismaType: string,
    hint: NativeTypeHint,
  ): TypeMappingResult {
    const name = hint.name.toLowerCase();

    switch (name) {
      case "text":
      case "mediumtext":
      case "longtext":
      case "tinytext":
        return { columnType: name === "longtext" ? "longtext" : "text" };
      case "varchar":
        return {
          columnType: "varchar",
          length: typeof hint.args[0] === "number" ? hint.args[0] : 255,
        };
      case "char":
        return {
          columnType: "char",
          length: typeof hint.args[0] === "number" ? hint.args[0] : 1,
        };
      case "timestamptz":
        return { columnType: "timestamptz" };
      case "timestamp":
        return { columnType: "timestamp" };
      case "date":
        return { columnType: "date" };
      case "jsonb":
        return { columnType: "jsonb" };
      case "json":
        return { columnType: "json" };
      case "smallint":
      case "integer":
      case "int":
      case "tinyint":
      case "mediumint":
        return { columnType: "int" };
      case "bigint":
        return { columnType: "bigint" };
      case "real":
      case "float":
      case "float4":
        return { columnType: "float" };
      case "double":
      case "doubleprecision":
      case "float8":
        return { columnType: "double" };
      case "decimal":
      case "numeric":
      case "money": {
        const result: TypeMappingResult = { columnType: "double" };
        if (typeof hint.args[0] === "number") result.precision = hint.args[0];
        if (typeof hint.args[1] === "number") result.scale = hint.args[1];
        return result;
      }
      case "boolean":
      case "bool":
        return { columnType: "boolean" };
      case "blob":
      case "longblob":
      case "mediumblob":
      case "tinyblob":
      case "binary":
      case "varbinary":
      case "bytea":
        return { columnType: "blob" };
      default:
        // Fall back to base type mapping
        return this.mapBaseType(prismaType);
    }
  }
}
