/**
 * Turning database names into TypeScript names.
 *
 * Every name the emitters write as code (not inside a string literal) comes
 * from here and is a valid, non-colliding identifier: a column called
 * `order-id` or `2fa`, a table whose class would shadow `Date` or the imported
 * `Index` decorator, or two tables that singularize to the same class are all
 * resolved before any code is written.
 */

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/** Whether `name` can be written as a bare TypeScript identifier. */
export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

/** Words of a database name: runs of letters and digits. */
function words(name: string): string[] {
  return name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/**
 * Class names the generated modules cannot declare: the globals decorator
 * metadata refers to (`design:type` emits `String`, `Date`, `Object`, …) and
 * every name the generated files import. A table that would produce one gets
 * an `Entity` suffix instead.
 */
const RESERVED_CLASS_NAMES = new Set([
  "Object",
  "String",
  "Number",
  "Boolean",
  "Date",
  "Buffer",
  "Array",
  "Symbol",
  "BigInt",
  "Function",
  "Promise",
  "Map",
  "Set",
  "Error",
  "JSON",
  "Math",
  "Reflect",
  "Proxy",
  "RegExp",
  "Infinity",
  "NaN",
  // Imported by the emitted files.
  "Entity",
  "Column",
  "PrimaryColumn",
  "PrimaryGeneratedColumn",
  "CreateTimestamp",
  "UpdateTimestamp",
  "DeletedAt",
  "Index",
  "UniqueIndex",
  "ManyToOne",
  "RelationColumn",
  "Relation",
  "InferEntity",
  "AnyEntityClass",
]);

/**
 * Property names that do not work as entity fields: a class field cannot be
 * called `constructor`, and `__proto__` in the code-first object literal sets
 * the prototype instead of declaring a field.
 */
const RESERVED_PROPERTY_NAMES = new Set(["constructor", "__proto__"]);

/**
 * `user_profiles` → `UserProfile`. Strips a simple plural (`ies` → `y`,
 * `ses`/`xes`/`zes` → drop `es`, a trailing `s` but not `ss`).
 */
export function tableNameToClassName(tableName: string): string {
  let singular = tableName;
  if (singular.endsWith("ies")) {
    singular = singular.slice(0, -3) + "y";
  } else if (
    singular.endsWith("ses") ||
    singular.endsWith("xes") ||
    singular.endsWith("zes")
  ) {
    singular = singular.slice(0, -2);
  } else if (singular.endsWith("s") && !singular.endsWith("ss")) {
    singular = singular.slice(0, -1);
  }
  return pascalCase(singular);
}

function pascalCase(name: string): string {
  const joined = words(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  if (joined === "") return "Table";
  return /^\p{N}/u.test(joined) ? `Table${joined}` : joined;
}

/**
 * `UserProfile` → `user-profile.entity.ts`.
 */
export function classNameToFileName(className: string): string {
  return `${fileBase(className)}.ts`;
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

/**
 * `user_name` → `userName`. A name without separators keeps its inner
 * capitals (`updatedAt` stays, `IsValid` → `isValid`); other characters that
 * cannot appear in an identifier separate words (`order-id` → `orderId`), and
 * a leading digit gets an underscore (`2fa_code` → `_2faCode`).
 */
export function columnNameToPropertyName(columnName: string): string {
  const parts = words(columnName);
  if (parts.length === 0) return "";
  let name: string;
  if (parts.length === 1 && parts[0] === columnName) {
    name = columnName.charAt(0).toLowerCase() + columnName.slice(1);
  } else {
    name = parts
      .map((part, i) =>
        i === 0
          ? part.toLowerCase()
          : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
      )
      .join("");
  }
  return /^\p{N}/u.test(name) ? `_${name}` : name;
}

/**
 * A FK column's relation name: `post_id` → `post`, `id_ancestor` →
 * `ancestor`, anything else camelCased.
 */
export function fkToPropertyName(columnName: string): string {
  let name = columnName;
  if (/_id$/i.test(name) && name.length > 3) {
    name = name.slice(0, -3);
  } else if (/^id_/i.test(name) && name.length > 3) {
    name = name.slice(3);
  }
  return columnNameToPropertyName(name);
}

/**
 * Hands out the property names of one entity, so none repeats and none is a
 * name a field cannot have.
 */
export class PropertyNamer {
  private readonly used = new Set<string>();

  /** Whether `name` is already taken. */
  has(name: string): boolean {
    return this.used.has(name);
  }

  /**
   * Claims the first free name among `preferred` (in order), falling back to
   * the first one with a numeric suffix. Empty and reserved names are skipped.
   */
  claim(...preferred: string[]): string {
    const usable = preferred
      .map((name) => (RESERVED_PROPERTY_NAMES.has(name) ? `${name}_` : name))
      .filter((name) => name !== "" && isIdentifier(name));
    const base = usable[0] ?? "column";
    let name = usable.find((candidate) => !this.used.has(candidate));
    for (let n = 2; name === undefined; n++) {
      if (!this.used.has(`${base}${n}`)) name = `${base}${n}`;
    }
    this.used.add(name);
    return name;
  }
}

/**
 * Class and file names for every generated table, decided together so two
 * tables never produce the same class (`user` and `users`) or the same file
 * on a case-insensitive file system.
 */
export class SchemaNaming {
  private readonly classNames = new Map<string, string>();

  constructor(tableNames: string[]) {
    const takenFiles = new Set<string>();
    for (const table of [...tableNames].sort()) {
      const singular = safeClassName(tableNameToClassName(table));
      const plural = safeClassName(pascalCase(table));
      let name = [singular, plural].find((c) => !takenFiles.has(fileBase(c)));
      for (let n = 2; name === undefined; n++) {
        if (!takenFiles.has(fileBase(`${singular}${n}`))) name = `${singular}${n}`;
      }
      takenFiles.add(fileBase(name));
      this.classNames.set(table, name);
    }
  }

  /** The class of a generated table, or the default spelling for any other. */
  classNameOf(table: string): string {
    return this.classNames.get(table) ?? safeClassName(tableNameToClassName(table));
  }
}

function safeClassName(name: string): string {
  return RESERVED_CLASS_NAMES.has(name) ? `${name}Entity` : name;
}
