/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializerRegistry } from "../../src/core/DeserializerRegistry";
import { ClassTransformerDeserializer } from "../../src/core/ClassTransformerDeserializer";
import { Deserializer } from "../../src/core/Deserializer";

class TestUser {
  name!: string;
  age!: number;
}

function createCustomDeserializer(onCall?: () => void): Deserializer {
  return {
    deserialize(cls: any, plain: any): any {
      if (onCall) onCall();
      return Object.assign(new cls(), plain);
    },
  };
}

describe("DeserializerRegistry", () => {
  describe("constructor", () => {
    it("should use ClassTransformerDeserializer as default", () => {
      const registry = new DeserializerRegistry();
      const deserializer = registry.getDeserializer();

      expect(deserializer).toBeInstanceOf(ClassTransformerDeserializer);
    });

    it("should accept a custom deserializer", () => {
      const custom = createCustomDeserializer();

      const registry = new DeserializerRegistry(custom);
      expect(registry.getDeserializer()).toBe(custom);
    });
  });

  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const instance1 = DeserializerRegistry.getInstance();
      const instance2 = DeserializerRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });

    it("should return an instance with default deserializer", () => {
      const instance = DeserializerRegistry.getInstance();
      expect(instance.getDeserializer()).toBeInstanceOf(
        ClassTransformerDeserializer,
      );
    });
  });

  describe("setDeserializer", () => {
    it("should replace the deserializer strategy", () => {
      const registry = new DeserializerRegistry();
      const custom = createCustomDeserializer();

      registry.setDeserializer(custom);
      expect(registry.getDeserializer()).toBe(custom);
    });
  });

  describe("deserialize", () => {
    it("should deserialize a plain object to class instance", () => {
      const registry = new DeserializerRegistry();
      const plain = { name: "Alice", age: 30 };

      const result = registry.deserialize(TestUser, plain);

      expect(result).toBeInstanceOf(TestUser);
      expect(result.name).toBe("Alice");
      expect(result.age).toBe(30);
    });

    it("should delegate to the configured deserializer", () => {
      let called = false;
      const custom = createCustomDeserializer(() => {
        called = true;
      });

      const registry = new DeserializerRegistry(custom);
      registry.deserialize(TestUser, { name: "Bob", age: 25 });

      expect(called).toBe(true);
    });
  });
});

describe("ClassTransformerDeserializer", () => {
  let deserializer: ClassTransformerDeserializer;

  beforeEach(() => {
    deserializer = new ClassTransformerDeserializer();
  });

  it("should convert plain object to class instance", () => {
    const plain = { name: "Charlie", age: 35 };
    const result = deserializer.deserialize(TestUser, plain);

    expect(result).toBeInstanceOf(TestUser);
    expect(result.name).toBe("Charlie");
    expect(result.age).toBe(35);
  });

  it("should handle extra properties on plain object", () => {
    const plain = { name: "Dave", age: 40, extra: "field" } as any;
    const result = deserializer.deserialize(TestUser, plain);

    expect(result).toBeInstanceOf(TestUser);
    expect(result.name).toBe("Dave");
    expect((result as any).extra).toBe("field");
  });

  it("should respect excludeExtraneousValues option", () => {
    const plain = { name: "Eve", age: 28, extra: "data" } as any;
    const result = deserializer.deserialize(TestUser, plain, {
      excludeExtraneousValues: true,
    });

    expect(result).toBeInstanceOf(TestUser);
  });
});
