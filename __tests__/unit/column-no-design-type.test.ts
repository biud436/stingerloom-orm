import "reflect-metadata";
import { Column, COLUMN_TOKEN, ResolvedColumnOption } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Logger } from "../../src/utils/Logger";

/**
 * Columns compiled without emitDecoratorMetadata (esbuild, tsx, swc, Vite —
 * the common Express dev toolchains) have no design:type metadata at all.
 * Applying the decorator functions manually reproduces that environment:
 * no design:type is ever defined on the prototype.
 */
function columnOptions(
  target: object,
  propertyKey: string,
): ResolvedColumnOption {
  const columns = Reflect.getMetadata(COLUMN_TOKEN, target) ?? [];
  const meta = columns.find(
    (c: { propertyKey: string }) => c.propertyKey === propertyKey,
  );
  expect(meta).toBeDefined();
  return meta.options;
}

describe("Column without design:type metadata (emitDecoratorMetadata off)", () => {
  let logLines: string[];
  const warnings = () => logLines.filter((l) => l.includes("WARN"));

  beforeEach(() => {
    logLines = [];
    Logger.setOutput((msg) => logLines.push(msg));
  });

  afterEach(() => {
    Logger.reset();
  });

  it("does not warn when an explicit type is provided", () => {
    class NoMetaExplicit {}
    Column({ type: "int" })(NoMetaExplicit.prototype, "balance");

    expect(warnings()).toHaveLength(0);
  });

  it("keeps explicit-type columns NOT NULL by default, matching tsc builds", () => {
    class NoMetaNullability {}
    Column({ type: "int" })(NoMetaNullability.prototype, "balance");

    const options = columnOptions(NoMetaNullability.prototype, "balance");
    expect(options.type).toBe("int");
    expect(options.nullable).toBe(false);
  });

  it("still honors an explicit nullable option", () => {
    class NoMetaNullable {}
    Column({ type: "varchar", nullable: true })(
      NoMetaNullable.prototype,
      "note",
    );

    const options = columnOptions(NoMetaNullable.prototype, "note");
    expect(options.nullable).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it("does not warn for @PrimaryGeneratedColumn and keeps it int", () => {
    class NoMetaPk {}
    PrimaryGeneratedColumn()(NoMetaPk.prototype, "id");

    const options = columnOptions(NoMetaPk.prototype, "id");
    expect(options.type).toBe("int");
    expect(options.primary).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it("warns with a build-tool diagnosis when no type can be inferred", () => {
    class NoMetaInferred {}
    Column()(NoMetaInferred.prototype, "name");

    expect(warnings()).toHaveLength(1);
    const message = warnings()[0];
    expect(message).toContain("NoMetaInferred.name");
    expect(message).toContain("emitDecoratorMetadata");
    expect(message).toContain("defineEntity");

    const options = columnOptions(NoMetaInferred.prototype, "name");
    expect(options.type).toBe("text");
    expect(options.nullable).toBe(true);
  });

  it("keeps the union-type message for design:type Object", () => {
    class ObjectTyped {}
    Reflect.defineMetadata(
      "design:type",
      Object,
      ObjectTyped.prototype,
      "profile",
    );
    Column()(ObjectTyped.prototype, "profile");

    expect(warnings()).toHaveLength(1);
    const message = warnings()[0];
    expect(message).toContain('Unknown design:type "Object"');
    expect(message).toContain("ObjectTyped.profile");
    // Both causes are named: nullable scalars and object values.
    expect(message).toContain("string | null");
    expect(message).toContain('type: "json"');

    const options = columnOptions(ObjectTyped.prototype, "profile");
    expect(options.type).toBe("text");
  });

  it("maps design:type Array to a nullable json column without a warning", () => {
    class ArrayTyped {}
    Reflect.defineMetadata("design:type", Array, ArrayTyped.prototype, "tags");
    Column()(ArrayTyped.prototype, "tags");

    expect(warnings()).toHaveLength(0);
    const options = columnOptions(ArrayTyped.prototype, "tags");
    expect(options.type).toBe("json");
    expect(options.nullable).toBe(true);
  });

  it("keeps an Array property with a write transformer on text, with an Array-specific warning", () => {
    class ArrayTransformed {}
    Reflect.defineMetadata(
      "design:type",
      Array,
      ArrayTransformed.prototype,
      "tags",
    );
    Column({
      transformer: {
        to: (v: string[]) => v.join(","),
        from: (v: string) => v.split(","),
      },
    })(ArrayTransformed.prototype, "tags");

    const options = columnOptions(ArrayTransformed.prototype, "tags");
    expect(options.type).toBe("text");
    expect(options.nullable).toBe(true);

    expect(warnings()).toHaveLength(1);
    const message = warnings()[0];
    expect(message).toContain('design:type "Array" with a write transformer');
    expect(message).toContain("ArrayTransformed.tags");
    // The union/nullable hint belongs to Object only.
    expect(message).not.toContain("string | null");
  });

  /**
   * A read-only transform has no write side, so it does not decide what the
   * column stores: inference stays json and the column keeps accepting an
   * array. Only `transformer.to` pins the column to text.
   */
  it("maps an Array property with the deprecated read-only transform to json", () => {
    class ArrayLegacyTransform {}
    Reflect.defineMetadata(
      "design:type",
      Array,
      ArrayLegacyTransform.prototype,
      "tags",
    );
    Column({ transform: (raw: unknown) => String(raw).split(",") as any })(
      ArrayLegacyTransform.prototype,
      "tags",
    );

    expect(columnOptions(ArrayLegacyTransform.prototype, "tags").type).toBe("json");
    expect(warnings()).toHaveLength(0);
  });

  it("maps an Array property with a read-only transformer to json", () => {
    class ArrayReadTransformer {}
    Reflect.defineMetadata(
      "design:type",
      Array,
      ArrayReadTransformer.prototype,
      "tags",
    );
    Column({ transformer: { from: (v: string) => v.split(",") } })(
      ArrayReadTransformer.prototype,
      "tags",
    );

    expect(columnOptions(ArrayReadTransformer.prototype, "tags").type).toBe("json");
    expect(warnings()).toHaveLength(0);
  });

  it("does not warn for an explicitly typed Array property with a transformer", () => {
    class ArrayExplicit {}
    Reflect.defineMetadata("design:type", Array, ArrayExplicit.prototype, "tags");
    Column({
      type: "varchar",
      transformer: { to: (v: string[]) => v.join(",") },
    })(ArrayExplicit.prototype, "tags");

    expect(warnings()).toHaveLength(0);
    expect(columnOptions(ArrayExplicit.prototype, "tags").type).toBe("varchar");
  });

  it("drops the union hint for other constructors", () => {
    class Money {}
    class ClassTyped {}
    Reflect.defineMetadata("design:type", Money, ClassTyped.prototype, "price");
    Column()(ClassTyped.prototype, "price");

    expect(warnings()).toHaveLength(1);
    const message = warnings()[0];
    expect(message).toContain('Unknown design:type "Money"');
    expect(message).not.toContain("Union");
    expect(message).not.toContain("string | null");
  });

  it("preserves nullable:true for explicit types on Object-typed properties (tsc historical behavior)", () => {
    class JsonEntity {}
    Reflect.defineMetadata(
      "design:type",
      Object,
      JsonEntity.prototype,
      "data",
    );
    Column({ type: "json" })(JsonEntity.prototype, "data");

    const options = columnOptions(JsonEntity.prototype, "data");
    expect(options.type).toBe("json");
    expect(options.nullable).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it("keeps historical behavior when design:type is present", () => {
    class WithMeta {}
    Reflect.defineMetadata("design:type", Number, WithMeta.prototype, "count");
    Column({ type: "int" })(WithMeta.prototype, "count");

    const options = columnOptions(WithMeta.prototype, "count");
    expect(options.type).toBe("int");
    expect(options.length).toBe(11);
    expect(options.nullable).toBe(false);
    expect(warnings()).toHaveLength(0);
  });
});
