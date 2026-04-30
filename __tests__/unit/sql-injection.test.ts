/* eslint-disable @typescript-eslint/no-explicit-any */
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { Conditions } from "../../src/core/Conditions";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

/**
 * SQL Injection 방지 테스트
 *
 * 드라이버의 wrap() 메서드가 식별자 내 특수 문자를 올바르게 이스케이프하는지,
 * Conditions의 operator 화이트리스트가 악성 입력을 차단하는지 검증합니다.
 */

// 실제 DB 연결 없이 드라이버의 wrap() 메서드만 테스트하기 위한 mock connector
const mockConnector: any = {
  query: jest.fn().mockResolvedValue([]),
};

describe("MySqlDriver - wrap() SQL Injection 방지", () => {
  let driver: MySqlDriver;

  beforeEach(() => {
    driver = new MySqlDriver(mockConnector);
  });

  it("should wrap normal column name with backticks", () => {
    expect(driver.wrap("name")).toBe("`name`");
  });

  it("should wrap table name with backticks", () => {
    expect(driver.wrap("users")).toBe("`users`");
  });

  it("should escape backticks inside identifier", () => {
    expect(driver.wrap("name`injection")).toBe("`name``injection`");
  });

  it("should escape multiple backticks", () => {
    expect(driver.wrap("col``umn")).toBe("`col````umn`");
  });

  it("should handle identifier that is only backticks", () => {
    // 3 backticks → each doubled (3×2=6) + 2 delimiters = 8 backticks total
    expect(driver.wrap("```")).toBe("````````");
  });

  it("should handle empty string", () => {
    expect(driver.wrap("")).toBe("``");
  });

  it("should prevent SQL injection via backtick breakout", () => {
    // Attacker tries: ` ; DROP TABLE users; --
    const malicious = "` ; DROP TABLE users; --";
    const wrapped = driver.wrap(malicious);

    // Backtick should be doubled, preventing breakout
    expect(wrapped).toBe("``` ; DROP TABLE users; --`");
    // The result should NOT contain an unescaped backtick breakout
    expect(wrapped.startsWith("`")).toBe(true);
    expect(wrapped.endsWith("`")).toBe(true);
  });

  it("should handle identifier with single quotes (not affected by MySQL wrap)", () => {
    const result = driver.wrap("col'name");
    expect(result).toBe("`col'name`");
  });

  it("should handle identifier with double quotes", () => {
    const result = driver.wrap('col"name');
    expect(result).toBe('`col"name`');
  });
});

describe("PostgresDriver - wrap() SQL Injection 방지", () => {
  let driver: PostgresDriver;

  beforeEach(() => {
    driver = new PostgresDriver(mockConnector);
  });

  it("should wrap normal column name with double quotes", () => {
    expect(driver.wrap("name")).toBe('"name"');
  });

  it("should wrap table name with double quotes", () => {
    expect(driver.wrap("users")).toBe('"users"');
  });

  it("should escape double quotes inside identifier", () => {
    expect(driver.wrap('name"injection')).toBe('"name""injection"');
  });

  it("should escape multiple double quotes", () => {
    expect(driver.wrap('col""umn')).toBe('"col""""umn"');
  });

  it("should handle empty string", () => {
    expect(driver.wrap("")).toBe('""');
  });

  it("should prevent SQL injection via double quote breakout", () => {
    // Attacker tries: " ; DROP TABLE users; --
    const malicious = '" ; DROP TABLE users; --';
    const wrapped = driver.wrap(malicious);

    // Double quote should be doubled, preventing breakout
    expect(wrapped).toBe('""" ; DROP TABLE users; --"');
    expect(wrapped.startsWith('"')).toBe(true);
    expect(wrapped.endsWith('"')).toBe(true);
  });

  it("should handle identifier with backticks (not affected by PostgreSQL wrap)", () => {
    const result = driver.wrap("col`name");
    expect(result).toBe('"col`name"');
  });

  it("should handle identifier with single quotes", () => {
    const result = driver.wrap("col'name");
    expect(result).toBe('"col\'name"');
  });
});

describe("PostgresDriver - wrapQualified()", () => {
  it("should produce schema-qualified identifier with default schema", () => {
    const driver = new PostgresDriver(mockConnector);
    expect(driver.wrapQualified("users")).toBe('"public"."users"');
  });

  it("should produce schema-qualified identifier with custom schema", () => {
    const driver = new PostgresDriver(mockConnector, "postgres", "tenant_1");
    expect(driver.wrapQualified("orders")).toBe('"tenant_1"."orders"');
  });

  it("should escape quotes in schema name", () => {
    const driver = new PostgresDriver(
      mockConnector,
      "postgres",
      'my"schema',
    );
    expect(driver.wrapQualified("users")).toBe('"my""schema"."users"');
  });

  it("should escape quotes in table name within qualified identifier", () => {
    const driver = new PostgresDriver(mockConnector);
    expect(driver.wrapQualified('my"table')).toBe('"public"."my""table"');
  });
});

describe("Conditions - operator 화이트리스트 검증", () => {
  describe("compareColumns - 허용된 연산자", () => {
    const allowedOperators = [
      "=",
      "!=",
      "<>",
      "<",
      ">",
      "<=",
      ">=",
      "LIKE",
    ];

    allowedOperators.forEach((op) => {
      it(`should allow operator: ${op}`, () => {
        expect(() => {
          Conditions.compareColumns("col1", op, "col2");
        }).not.toThrow();
      });
    });

    const rejectedForColumns = ["IN", "NOT IN", "IS NULL", "IS NOT NULL"];
    rejectedForColumns.forEach((op) => {
      it(`should reject operator for column comparison: ${op}`, () => {
        expect(() => {
          Conditions.compareColumns("col1", op, "col2");
        }).toThrow(/Invalid operator for column comparison/);
      });
    });

    it("should allow operators case-insensitively", () => {
      expect(() => {
        Conditions.compareColumns("col1", "like", "col2");
      }).not.toThrow();

      expect(() => {
        Conditions.compareColumns("col1", "Like", "col2");
      }).not.toThrow();
    });

    it("should allow operators with whitespace", () => {
      expect(() => {
        Conditions.compareColumns("col1", "  =  ", "col2");
      }).not.toThrow();
    });
  });

  describe("compareColumns - 차단된 연산자 (SQL Injection 방지)", () => {
    it("should reject SQL injection via operator", () => {
      expect(() => {
        Conditions.compareColumns("col1", "= 1; DROP TABLE users; --", "col2");
      }).toThrow(/Invalid operator/);
    });

    it("should reject UNION-based injection via operator", () => {
      expect(() => {
        Conditions.compareColumns(
          "col1",
          "= 1 UNION SELECT * FROM passwords --",
          "col2",
        );
      }).toThrow(/Invalid operator/);
    });

    it("should reject OR-based injection via operator", () => {
      expect(() => {
        Conditions.compareColumns("col1", "= 1 OR 1=1 --", "col2");
      }).toThrow(/Invalid operator/);
    });

    it("should reject empty operator", () => {
      expect(() => {
        Conditions.compareColumns("col1", "", "col2");
      }).toThrow(/Invalid operator/);
    });

    it("should reject arbitrary string as operator", () => {
      expect(() => {
        Conditions.compareColumns("col1", "EXECUTE", "col2");
      }).toThrow(/Invalid operator/);
    });
  });

  describe("compareSubquery - 동일한 화이트리스트 적용", () => {
    it("should allow valid operator with subquery", () => {
      const subquery = Conditions.raw("(SELECT 1)");
      expect(() => {
        Conditions.compareSubquery("col", "=", subquery);
      }).not.toThrow();
    });

    it("should reject malicious operator with subquery", () => {
      const subquery = Conditions.raw("(SELECT 1)");
      expect(() => {
        Conditions.compareSubquery(
          "col",
          "; DROP TABLE users --",
          subquery,
        );
      }).toThrow(/Invalid operator/);
    });
  });
});

describe("MySqlDriver - castType", () => {
  let driver: MySqlDriver;

  beforeEach(() => {
    driver = new MySqlDriver(mockConnector);
  });

  it("should map varchar to VARCHAR", () => {
    expect(driver.castType("varchar")).toBe("VARCHAR");
  });

  it("should map int to INT", () => {
    expect(driver.castType("int")).toBe("INT");
  });

  it("should map number to INT", () => {
    expect(driver.castType("number")).toBe("INT");
  });

  it("should map boolean to TINYINT($n)", () => {
    expect(driver.castType("boolean")).toBe("TINYINT($n)");
  });

  it("should map json to JSON", () => {
    expect(driver.castType("json")).toBe("JSON");
  });

  it("should map jsonb to JSON (MySQL)", () => {
    expect(driver.castType("jsonb")).toBe("JSON");
  });

  it("should map array to JSON (MySQL)", () => {
    expect(driver.castType("array")).toBe("JSON");
  });

  it("should map blob to BLOB", () => {
    expect(driver.castType("blob")).toBe("BLOB");
  });

  it("should map bigint to BIGINT", () => {
    expect(driver.castType("bigint")).toBe("BIGINT");
  });
});

describe("PostgresDriver - castType", () => {
  let driver: PostgresDriver;

  beforeEach(() => {
    driver = new PostgresDriver(mockConnector);
  });

  it("should map varchar to VARCHAR", () => {
    expect(driver.castType("varchar")).toBe("VARCHAR");
  });

  it("should map int to INTEGER", () => {
    expect(driver.castType("int")).toBe("INTEGER");
  });

  it("should map boolean to BOOLEAN (native)", () => {
    expect(driver.castType("boolean")).toBe("BOOLEAN");
  });

  it("should map datetime to TIMESTAMP", () => {
    expect(driver.castType("datetime")).toBe("TIMESTAMP");
  });

  it("should map blob to BYTEA", () => {
    expect(driver.castType("blob")).toBe("BYTEA");
  });

  it("should map float to REAL", () => {
    expect(driver.castType("float")).toBe("REAL");
  });

  it("should map jsonb to JSONB", () => {
    expect(driver.castType("jsonb")).toBe("JSONB");
  });

  it("should map longtext to TEXT", () => {
    expect(driver.castType("longtext")).toBe("TEXT");
  });

  it("should map enum to USER-DEFINED (matches information_schema introspection)", () => {
    expect(driver.castType("enum")).toBe("USER-DEFINED");
  });
});

// ────────────────────────────────────────────────────────────
// #297 — PostgresConnector.validateIdentifier regex
//
// Commit 9571d2e relaxed the validator to accept hyphens (real-world tenant
// names like `tenant-acme`) but shipped without a test. This locks the
// surface: hyphens accepted, but only as non-leading characters; classic
// injection vectors still rejected.
// ────────────────────────────────────────────────────────────
describe("PostgresConnector.validateIdentifier (#297)", () => {
  // Private static — invoke through the typed any-cast so we exercise the
  // exact method that escapeIdentifier delegates to.
  const validate = (PostgresConnector as any).validateIdentifier as (
    name: string,
  ) => void;

  it("accepts hyphenated tenant names like 'tenant-acme'", () => {
    expect(() => validate("tenant-acme")).not.toThrow();
  });

  it("accepts underscores, dollar signs, and digits in non-leading positions", () => {
    expect(() => validate("user_table$2")).not.toThrow();
    expect(() => validate("_private")).not.toThrow();
    expect(() => validate("a1$_-x")).not.toThrow();
  });

  it("rejects a leading hyphen — hyphens cannot start an identifier", () => {
    let caught: unknown;
    try {
      validate("-leading");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.INVALID_QUERY);
    expect((caught as OrmError).message).toContain("-leading");
  });

  it("rejects classic injection vectors (semicolon, whitespace, quote)", () => {
    expect(() => validate("drop;table")).toThrow(OrmError);
    expect(() => validate("a b")).toThrow(OrmError);
    expect(() => validate('a"b')).toThrow(OrmError);
    expect(() => validate("a' OR 1=1 --")).toThrow(OrmError);
  });

  it("rejects a leading digit — identifiers must start with letter or underscore", () => {
    expect(() => validate("1table")).toThrow(OrmError);
  });

  it("error message hints at the accepted character set including hyphens", () => {
    let caught: unknown;
    try {
      validate("bad name");
    } catch (e) {
      caught = e;
    }
    // The hint must mention hyphens — that is the v9571d2e contract; if a
    // future revert drops "hyphen" from the message users won't know what
    // changed.
    const msg = `${(caught as OrmError).message} ${
      ((caught as OrmError) as any).suggestion ?? ""
    }`;
    expect(msg.toLowerCase()).toContain("hyphen");
  });
});
