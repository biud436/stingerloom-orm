import { DeepPartial } from "../../src/types/DeepPartial";

import { OrderByOption, SortDirection } from "../../src/types/OrderByOption";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { EntityMetadataNotFoundError } from "../../src/errors/EntityMetadataNotFoundError";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import { PrimaryKeyNotFoundError } from "../../src/errors/PrimaryKeyNotFoundError";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { TransactionError } from "../../src/errors/TransactionError";
import { DeleteWithoutConditionsError } from "../../src/errors/DeleteWithoutConditionsError";

// -- Test entities --

interface Profile {
  bio: string;
  avatar: string;
}

interface User {
  id: number;
  name: string;
  age: number;
  email: string;
  profile: Profile;
  tags: string[];
  isActive: boolean;
}

// ==========================
// DeepPartial type tests
// ==========================
describe("DeepPartial", () => {
  it("should make top-level properties optional", () => {
    const partial: DeepPartial<User> = {};
    expect(partial).toEqual({});
  });

  it("should allow partial top-level properties", () => {
    const partial: DeepPartial<User> = { name: "Alice" };
    expect(partial.name).toBe("Alice");
  });

  it("should make nested object properties optional", () => {
    const partial: DeepPartial<User> = {
      profile: { bio: "hello" },
    };
    expect(partial.profile?.bio).toBe("hello");
    expect(partial.profile?.avatar).toBeUndefined();
  });

  it("should handle arrays", () => {
    const partial: DeepPartial<User> = {
      tags: ["ts", "orm"],
    };
    expect(partial.tags).toEqual(["ts", "orm"]);
  });

  it("should allow primitive types unchanged", () => {
    type Str = DeepPartial<string>;
    const val: Str = "hello";
    expect(val).toBe("hello");
  });
});


// ==========================
// OrderByOption type tests
// ==========================
describe("OrderByOption", () => {
  it("should allow ASC sorting", () => {
    const order: OrderByOption<User> = { name: "ASC" };
    expect(order.name).toBe("ASC");
  });

  it("should allow DESC sorting", () => {
    const order: OrderByOption<User> = { age: "DESC" };
    expect(order.age).toBe("DESC");
  });

  it("should allow multiple sort fields", () => {
    const order: OrderByOption<User> = {
      name: "ASC",
      age: "DESC",
    };
    expect(order.name).toBe("ASC");
    expect(order.age).toBe("DESC");
  });

  it("should allow empty ordering", () => {
    const order: OrderByOption<User> = {};
    expect(order).toEqual({});
  });

  it("should only allow ASC or DESC as SortDirection", () => {
    const dir1: SortDirection = "ASC";
    const dir2: SortDirection = "DESC";
    expect(dir1).toBe("ASC");
    expect(dir2).toBe("DESC");
  });
});

// ==========================
// OrmError hierarchy tests
// ==========================
describe("OrmError hierarchy", () => {
  describe("OrmError base", () => {
    it("should have code and message", () => {
      const error = new OrmError(OrmErrorCode.INVALID_QUERY, "test message");
      expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
      expect(error.message).toBe("test message");
      expect(error.name).toBe("OrmError");
    });

    it("should be an instance of Error", () => {
      const error = new OrmError(OrmErrorCode.INVALID_QUERY, "test");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(OrmError);
    });
  });

  describe("EntityMetadataNotFoundError", () => {
    it("should set correct code and message", () => {
      const error = new EntityMetadataNotFoundError("User");
      expect(error.code).toBe(OrmErrorCode.ENTITY_METADATA_NOT_FOUND);
      expect(error.message).toContain("User");
      expect(error.name).toBe("EntityMetadataNotFoundError");
    });

    it("should be an instance of OrmError", () => {
      const error = new EntityMetadataNotFoundError("User");
      expect(error).toBeInstanceOf(OrmError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("EntityNotFoundError", () => {
    it("should set correct code and message", () => {
      const error = new EntityNotFoundError("User");
      expect(error.code).toBe(OrmErrorCode.ENTITY_NOT_FOUND);
      expect(error.message).toContain("User");
      expect(error.name).toBe("EntityNotFoundError");
    });

    it("should be an instance of OrmError", () => {
      const error = new EntityNotFoundError("User");
      expect(error).toBeInstanceOf(OrmError);
    });
  });

  describe("PrimaryKeyNotFoundError", () => {
    it("should set correct code and message", () => {
      const error = new PrimaryKeyNotFoundError("User");
      expect(error.code).toBe(OrmErrorCode.PRIMARY_KEY_NOT_FOUND);
      expect(error.message).toContain("User");
      expect(error.name).toBe("PrimaryKeyNotFoundError");
    });

    it("should be an instance of OrmError", () => {
      const error = new PrimaryKeyNotFoundError("User");
      expect(error).toBeInstanceOf(OrmError);
    });
  });

  describe("InvalidQueryError", () => {
    it("should set correct code and message", () => {
      const error = new InvalidQueryError("bad query");
      expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
      expect(error.message).toBe("bad query");
      expect(error.name).toBe("InvalidQueryError");
    });

    it("should be an instance of OrmError", () => {
      const error = new InvalidQueryError("test");
      expect(error).toBeInstanceOf(OrmError);
    });
  });

  describe("TransactionError", () => {
    it("should set correct code and message", () => {
      const error = new TransactionError("tx failed");
      expect(error.code).toBe(OrmErrorCode.TRANSACTION_FAILED);
      expect(error.message).toBe("tx failed");
      expect(error.name).toBe("TransactionError");
    });

    it("should be an instance of OrmError", () => {
      const error = new TransactionError("test");
      expect(error).toBeInstanceOf(OrmError);
    });
  });

  describe("DeleteWithoutConditionsError", () => {
    it("should set correct code and default message", () => {
      const error = new DeleteWithoutConditionsError();
      expect(error.code).toBe(OrmErrorCode.DELETE_WITHOUT_CONDITIONS);
      expect(error.message).toContain("Delete without conditions");
      expect(error.name).toBe("DeleteWithoutConditionsError");
    });

    it("should accept custom operation name", () => {
      const error = new DeleteWithoutConditionsError("Soft delete");
      expect(error.message).toContain("Soft delete without conditions");
    });

    it("should accept restore operation", () => {
      const error = new DeleteWithoutConditionsError("Restore");
      expect(error.message).toContain("Restore without conditions");
    });

    it("should be an instance of OrmError", () => {
      const error = new DeleteWithoutConditionsError();
      expect(error).toBeInstanceOf(OrmError);
    });
  });

  describe("OrmErrorCode enum", () => {
    it("should have all expected error codes", () => {
      expect(OrmErrorCode.CONNECTION_FAILED).toBe("ORM_CONNECTION_FAILED");
      expect(OrmErrorCode.NOT_CONNECTED).toBe("ORM_NOT_CONNECTED");
      expect(OrmErrorCode.UNSUPPORTED_DATABASE).toBe("ORM_UNSUPPORTED_DATABASE");
      expect(OrmErrorCode.ENTITY_NOT_FOUND).toBe("ORM_ENTITY_NOT_FOUND");
      expect(OrmErrorCode.ENTITY_METADATA_NOT_FOUND).toBe("ORM_ENTITY_METADATA_NOT_FOUND");
      expect(OrmErrorCode.PRIMARY_KEY_NOT_FOUND).toBe("ORM_PRIMARY_KEY_NOT_FOUND");
      expect(OrmErrorCode.INVALID_QUERY).toBe("ORM_INVALID_QUERY");
      expect(OrmErrorCode.DELETE_WITHOUT_CONDITIONS).toBe("ORM_DELETE_WITHOUT_CONDITIONS");
      expect(OrmErrorCode.TRANSACTION_FAILED).toBe("ORM_TRANSACTION_FAILED");
      expect(OrmErrorCode.TRANSACTION_ROLLBACK_FAILED).toBe("ORM_TRANSACTION_ROLLBACK_FAILED");
      expect(OrmErrorCode.VALIDATION_FAILED).toBe("ORM_VALIDATION_FAILED");
    });
  });

  describe("catch by OrmError base class", () => {
    it("should catch all ORM errors via OrmError", () => {
      const errors: OrmError[] = [
        new EntityMetadataNotFoundError("User"),
        new EntityNotFoundError("User"),
        new PrimaryKeyNotFoundError("User"),
        new InvalidQueryError("bad"),
        new TransactionError("fail"),
        new DeleteWithoutConditionsError(),
      ];

      for (const error of errors) {
        expect(error).toBeInstanceOf(OrmError);
        expect(error.code).toBeDefined();
        expect(typeof error.code).toBe("string");
      }
    });

    it("should be catchable in try/catch with instanceof", () => {
      try {
        throw new EntityMetadataNotFoundError("User");
      } catch (e) {
        expect(e).toBeInstanceOf(OrmError);
        if (e instanceof OrmError) {
          expect(e.code).toBe(OrmErrorCode.ENTITY_METADATA_NOT_FOUND);
        }
      }
    });
  });
});
