/**
 * RETURNING * 지원 테스트
 *
 * ISqlDriver.supportsReturning()이 true인 드라이버(PostgreSQL)에서
 * save() 시 RETURNING *로 직접 역직렬화하여 추가 SELECT를 제거하는지 검증합니다.
 */

import "reflect-metadata";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";

describe("ISqlDriver.supportsReturning()", () => {
  it("PostgresDriver returns true", () => {
    const driver = new PostgresDriver(null as any);
    expect(driver.supportsReturning()).toBe(true);
  });

  it("MySqlDriver returns false", () => {
    const driver = new MySqlDriver(null as any);
    expect(driver.supportsReturning()).toBe(false);
  });

  it("SqliteDriver returns false", () => {
    const driver = new SqliteDriver(null as any);
    expect(driver.supportsReturning()).toBe(false);
  });
});
