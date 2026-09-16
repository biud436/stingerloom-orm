import { inferColumnDefaults } from "../../src/decorators/Column";

describe("inferColumnDefaults", () => {
  it("should infer String type as varchar with length 255", () => {
    const result = inferColumnDefaults(String);

    expect(result.type).toBe("varchar");
    expect(result.length).toBe(255);
    expect(result.nullable).toBe(false);
  });

  it("should infer Number type as int with length 11", () => {
    const result = inferColumnDefaults(Number);

    expect(result.type).toBe("int");
    expect(result.length).toBe(11);
    expect(result.nullable).toBe(false);
  });

  it("should infer Boolean type as boolean with length 1", () => {
    const result = inferColumnDefaults(Boolean);

    expect(result.type).toBe("boolean");
    expect(result.length).toBe(1);
    expect(result.nullable).toBe(false);
  });

  it("should infer Date type as datetime with length 0", () => {
    const result = inferColumnDefaults(Date);

    expect(result.type).toBe("datetime");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(false);
  });

  it("should infer Buffer type as blob, nullable", () => {
    const result = inferColumnDefaults(Buffer);

    expect(result.type).toBe("blob");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(true);
  });

  it("should fall back to text for unknown types", () => {
    class CustomType {}
    const result = inferColumnDefaults(CustomType);

    expect(result.type).toBe("text");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(true);
  });

  it("should fall back to text for undefined designType", () => {
    const result = inferColumnDefaults(undefined);

    expect(result.type).toBe("text");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(true);
  });

  it("should fall back to text for null designType", () => {
    const result = inferColumnDefaults(null);

    expect(result.type).toBe("text");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(true);
  });

  // Object stays text: under strictNullChecks it is also what `string | null`
  // and every other nullable scalar erase to.
  it("should fall back to text for Object type", () => {
    const result = inferColumnDefaults(Object);

    expect(result.type).toBe("text");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(true);
  });

  // tsc emits design:type Array only for array and tuple types, so the value
  // is structured and json is the one portable column type that stores it.
  // Binding the array to a text column spread it over the bind parameters.
  it("should infer Array type as json, nullable", () => {
    const result = inferColumnDefaults(Array);

    expect(result.type).toBe("json");
    expect(result.length).toBe(0);
    expect(result.nullable).toBe(true);
  });
});
