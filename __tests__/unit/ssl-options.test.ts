import "reflect-metadata";
import {
  DatabaseClientOptions,
  SslOptions,
  ServerDatabaseClientOptions,
  validateDatabaseClientOptions,
} from "../../src/core/DatabaseClientOptions";

describe("SSL/TLS Options", () => {
  const baseOptions: ServerDatabaseClientOptions = {
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "user",
    password: "pass",
    database: "testdb",
    entities: [],
  };

  describe("SslOptions type", () => {
    it("should accept ssl: true", () => {
      const options: DatabaseClientOptions = { ...baseOptions, ssl: true };
      expect(options.ssl).toBe(true);
    });

    it("should accept ssl: undefined (no SSL)", () => {
      const options: DatabaseClientOptions = { ...baseOptions };
      expect(options.ssl).toBeUndefined();
    });

    it("should accept ssl with ca only", () => {
      const options: DatabaseClientOptions = {
        ...baseOptions,
        ssl: { ca: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----" },
      };
      expect((options.ssl as SslOptions).ca).toContain("BEGIN CERTIFICATE");
    });

    it("should accept ssl with full mTLS config", () => {
      const sslConfig: SslOptions = {
        ca: "ca-cert",
        cert: "client-cert",
        key: "client-key",
        rejectUnauthorized: true,
      };
      const options: DatabaseClientOptions = { ...baseOptions, ssl: sslConfig };
      expect(options.ssl).toEqual(sslConfig);
    });

    it("should accept ssl with rejectUnauthorized: false", () => {
      const options: DatabaseClientOptions = {
        ...baseOptions,
        ssl: { rejectUnauthorized: false },
      };
      expect((options.ssl as SslOptions).rejectUnauthorized).toBe(false);
    });

    it("should accept ssl with Buffer values", () => {
      const options: DatabaseClientOptions = {
        ...baseOptions,
        ssl: { ca: Buffer.from("ca-data") },
      };
      expect(Buffer.isBuffer((options.ssl as SslOptions).ca)).toBe(true);
    });
  });

  describe("MySQL options with SSL", () => {
    it("should accept ssl on mysql type", () => {
      const options: DatabaseClientOptions = {
        ...baseOptions,
        type: "mysql",
        port: 3306,
        ssl: true,
      };
      expect(options.ssl).toBe(true);
    });

    it("should accept ssl on mariadb type", () => {
      const options: DatabaseClientOptions = {
        ...baseOptions,
        type: "mariadb",
        port: 3306,
        ssl: { ca: "cert" },
      };
      expect((options.ssl as SslOptions).ca).toBe("cert");
    });
  });

  describe("SQLite ignores SSL", () => {
    it("should not have ssl property on sqlite options", () => {
      const options: DatabaseClientOptions = {
        type: "sqlite",
        database: ":memory:",
        entities: [],
      };
      // SQLite options don't include ssl field
      expect("ssl" in options).toBe(false);
    });
  });

  describe("validateDatabaseClientOptions with SSL", () => {
    it("should pass validation with ssl: true", () => {
      expect(() =>
        validateDatabaseClientOptions({ ...baseOptions, ssl: true }),
      ).not.toThrow();
    });

    it("should pass validation with ssl object", () => {
      expect(() =>
        validateDatabaseClientOptions({
          ...baseOptions,
          ssl: { ca: "cert", rejectUnauthorized: false },
        }),
      ).not.toThrow();
    });

    it("should pass validation without ssl", () => {
      expect(() => validateDatabaseClientOptions(baseOptions)).not.toThrow();
    });
  });

  describe("SSL config resolution logic", () => {
    function resolveSsl(ssl: boolean | SslOptions | undefined): any {
      if (ssl === true) {
        return { rejectUnauthorized: true };
      } else if (ssl && typeof ssl === "object") {
        return { ...ssl };
      }
      return undefined;
    }

    it("should resolve ssl: true to { rejectUnauthorized: true }", () => {
      expect(resolveSsl(true)).toEqual({ rejectUnauthorized: true });
    });

    it("should resolve ssl object by spreading", () => {
      expect(resolveSsl({ ca: "ca", rejectUnauthorized: false })).toEqual({
        ca: "ca",
        rejectUnauthorized: false,
      });
    });

    it("should resolve ssl: undefined to undefined", () => {
      expect(resolveSsl(undefined)).toBeUndefined();
    });

    it("should resolve ssl: false to undefined", () => {
      expect(resolveSsl(false)).toBeUndefined();
    });
  });
});
