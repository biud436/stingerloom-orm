/**
 * toConstraintViolation() maps a driver's unique / foreign key violation to
 * the ORM's error, reading what each driver reports about the constraint.
 * The error shapes below are the ones pg, mysql2 and better-sqlite3 throw
 * (checked against PostgreSQL 16, MariaDB 11.8 and SQLite); the MySQL 8 key
 * format is from its documentation.
 */
import { toConstraintViolation } from "../../src/dialects/constraintViolation";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { UniqueConstraintViolationError } from "../../src/errors/UniqueConstraintViolationError";
import { ForeignKeyViolationError } from "../../src/errors/ForeignKeyViolationError";

function driverError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

function pgError(code: string, message: string, fields: Record<string, unknown> = {}) {
  return driverError(message, { code, severity: "ERROR", schema: "public", ...fields });
}

function mysqlError(errno: number, code: string, message: string) {
  return driverError(message, { errno, code, sqlState: "23000", sqlMessage: message });
}

function sqliteError(code: string, message: string) {
  return driverError(message, { code });
}

describe("toConstraintViolation", () => {
  describe("PostgreSQL", () => {
    it("maps 23505 with the constraint, table and key columns", () => {
      const cause = pgError("23505", 'duplicate key value violates unique constraint "users_email_key"', {
        table: "users",
        constraint: "users_email_key",
        detail: "Key (email)=(a@x.io) already exists.",
      });

      const error = toConstraintViolation(cause) as UniqueConstraintViolationError;

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error.code).toBe(OrmErrorCode.UNIQUE_VIOLATION);
      expect(error.message).toBe(cause.message);
      expect(error.cause).toBe(cause);
      expect(error.constraint).toBe("users_email_key");
      expect(error.table).toBe("users");
      expect(error.columns).toEqual(["email"]);
    });

    it("splits a composite key and unquotes quoted identifiers", () => {
      const error = toConstraintViolation(
        pgError("23505", "duplicate key", {
          detail: 'Key (org, "Display Name", "a""b")=(acme, x, y) already exists.',
        }),
      ) as UniqueConstraintViolationError;

      expect(error.columns).toEqual(["org", "Display Name", 'a"b']);
    });

    it("keeps an expression key as its text", () => {
      const error = toConstraintViolation(
        pgError("23505", "duplicate key", {
          detail: "Key (lower(email::text), coalesce(org, 'x'::text))=(a, b) already exists.",
        }),
      ) as UniqueConstraintViolationError;

      expect(error.columns).toEqual(["lower(email::text)", "coalesce(org, 'x'::text)"]);
    });

    it("leaves the columns unset when the server sends no detail", () => {
      const error = toConstraintViolation(
        pgError("23505", "duplicate key", { constraint: "uq" }),
      ) as UniqueConstraintViolationError;

      expect(error.constraint).toBe("uq");
      expect(error.table).toBeUndefined();
      expect(error.columns).toBeUndefined();
    });

    it("maps 23503 with the constraint and the referencing table", () => {
      const cause = pgError(
        "23503",
        'update or delete on table "users" violates foreign key constraint "posts_user_id_fkey" on table "posts"',
        {
          table: "posts",
          constraint: "posts_user_id_fkey",
          detail: 'Key (id)=(1) is still referenced from table "posts".',
        },
      );

      const error = toConstraintViolation(cause) as ForeignKeyViolationError;

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect(error.code).toBe(OrmErrorCode.FK_VIOLATION);
      expect(error.cause).toBe(cause);
      expect(error.constraint).toBe("posts_user_id_fkey");
      expect(error.table).toBe("posts");
    });

    it("leaves other SQLSTATEs alone", () => {
      for (const code of ["23502", "23514", "40001", "40P01", "42P01"]) {
        const cause = pgError(code, "other");
        expect(toConstraintViolation(cause)).toBe(cause);
      }
    });
  });

  describe("MySQL / MariaDB", () => {
    it("maps errno 1062 with the key name MariaDB reports", () => {
      const cause = mysqlError(1062, "ER_DUP_ENTRY", "Duplicate entry 'a@x.io' for key 'uq_email'");

      const error = toConstraintViolation(cause) as UniqueConstraintViolationError;

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error.cause).toBe(cause);
      expect(error.constraint).toBe("uq_email");
      expect(error.table).toBeUndefined();
      expect(error.columns).toBeUndefined();
    });

    it("splits MySQL 8's table-qualified key name", () => {
      const error = toConstraintViolation(
        mysqlError(1062, "ER_DUP_ENTRY", "Duplicate entry '1' for key 'users.PRIMARY'"),
      ) as UniqueConstraintViolationError;

      expect(error.table).toBe("users");
      expect(error.constraint).toBe("PRIMARY");
    });

    it("reads the key after a duplicated value that itself contains the marker", () => {
      const error = toConstraintViolation(
        mysqlError(1062, "ER_DUP_ENTRY", "Duplicate entry 'x' for key 'y-z' for key 'uq_name'"),
      ) as UniqueConstraintViolationError;

      expect(error.constraint).toBe("uq_name");
    });

    it("maps errnos 1451 and 1452 with the constraint and the referencing table", () => {
      const parent = mysqlError(
        1451,
        "ER_ROW_IS_REFERENCED_2",
        "Cannot delete or update a parent row: a foreign key constraint fails (`app`.`posts`, CONSTRAINT `fk_posts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`))",
      );
      const child = mysqlError(
        1452,
        "ER_NO_REFERENCED_ROW_2",
        "Cannot add or update a child row: a foreign key constraint fails (`app`.`posts`, CONSTRAINT `fk_posts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`))",
      );

      for (const cause of [parent, child]) {
        const error = toConstraintViolation(cause) as ForeignKeyViolationError;
        expect(error).toBeInstanceOf(ForeignKeyViolationError);
        expect(error.cause).toBe(cause);
        expect(error.table).toBe("posts");
        expect(error.constraint).toBe("fk_posts_user");
      }
    });

    it("unescapes doubled backticks in the names", () => {
      const error = toConstraintViolation(
        mysqlError(
          1452,
          "ER_NO_REFERENCED_ROW_2",
          "Cannot add or update a child row: a foreign key constraint fails (`app`.`we``ird`, CONSTRAINT `f``k` FOREIGN KEY (`a`) REFERENCES `b` (`id`))",
        ),
      ) as ForeignKeyViolationError;

      expect(error.table).toBe("we`ird");
      expect(error.constraint).toBe("f`k");
    });

    it("maps the detail-less errnos of old servers", () => {
      for (const errno of [1216, 1217]) {
        const error = toConstraintViolation(
          mysqlError(errno, "ER_NO_REFERENCED_ROW", "Cannot add or update a child row: a foreign key constraint fails"),
        ) as ForeignKeyViolationError;
        expect(error).toBeInstanceOf(ForeignKeyViolationError);
        expect(error.table).toBeUndefined();
        expect(error.constraint).toBeUndefined();
      }
    });

    it("leaves other errnos alone", () => {
      for (const errno of [1048, 1213, 1364, 3024]) {
        const cause = mysqlError(errno, "ER_OTHER", "other");
        expect(toConstraintViolation(cause)).toBe(cause);
      }
    });
  });

  describe("SQLite", () => {
    it("maps SQLITE_CONSTRAINT_UNIQUE with the table and columns", () => {
      const cause = sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: users.org, users.handle");

      const error = toConstraintViolation(cause) as UniqueConstraintViolationError;

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error.cause).toBe(cause);
      expect(error.table).toBe("users");
      expect(error.columns).toEqual(["org", "handle"]);
      expect(error.constraint).toBeUndefined();
    });

    it("maps SQLITE_CONSTRAINT_PRIMARYKEY", () => {
      const error = toConstraintViolation(
        sqliteError("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: users.id"),
      ) as UniqueConstraintViolationError;

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error.columns).toEqual(["id"]);
    });

    it("names the index of a unique index over an expression", () => {
      const error = toConstraintViolation(
        sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: index 'uq_lower_email'"),
      ) as UniqueConstraintViolationError;

      expect(error.constraint).toBe("uq_lower_email");
      expect(error.table).toBeUndefined();
      expect(error.columns).toBeUndefined();
    });

    it("maps SQLITE_CONSTRAINT_FOREIGNKEY, which names nothing", () => {
      const error = toConstraintViolation(
        sqliteError("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"),
      ) as ForeignKeyViolationError;

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect(error.table).toBeUndefined();
      expect(error.constraint).toBeUndefined();
    });

    it("leaves the other constraint codes alone", () => {
      for (const code of ["SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_CHECK", "SQLITE_BUSY", "SQLITE_ERROR"]) {
        const cause = sqliteError(code, "other");
        expect(toConstraintViolation(cause)).toBe(cause);
      }
    });
  });

  it("passes an OrmError and anything that is not an Error through", () => {
    const ormError = new OrmError(OrmErrorCode.INVALID_QUERY, "bad");
    expect(toConstraintViolation(ormError)).toBe(ormError);
    const notAnError = { code: "23505", message: "duplicate key" };
    expect(toConstraintViolation(notAnError)).toBe(notAnError);
    expect(toConstraintViolation(undefined)).toBeUndefined();
  });
});
