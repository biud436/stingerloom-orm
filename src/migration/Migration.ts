/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";

/**
 * 마이그레이션 실행 컨텍스트.
 * up/down 메서드에서 드라이버를 통해 DDL을 실행하거나,
 * query 함수를 통해 임의의 SQL을 실행할 수 있습니다.
 */
export interface MigrationContext {
  driver: ISqlDriver;
  query: (sql: string) => Promise<any>;
}

/**
 * 마이그레이션 추상 클래스.
 * 모든 마이그레이션은 이 클래스를 상속하고 up/down 메서드를 구현해야 합니다.
 */
export abstract class Migration {
  /**
   * 마이그레이션 이름. 기본값은 클래스명.
   */
  get name(): string {
    return this.constructor.name;
  }

  /**
   * 마이그레이션을 적용합니다 (스키마 변경 등).
   */
  abstract up(context: MigrationContext): Promise<void>;

  /**
   * 마이그레이션을 되돌립니다 (스키마 복원 등).
   */
  abstract down(context: MigrationContext): Promise<void>;
}
