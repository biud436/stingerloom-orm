import { RawQueryBuilder } from "./RawQueryBuilder";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";

export type QueryBuilderFactoryFn = () => BaseRawQueryBuilder;

/**
 * RawQueryBuilder 인스턴스를 생성하는 팩토리 클래스입니다.
 *
 * setStrategy()로 커스텀 QueryBuilder 전략을 등록하면
 * create()/subquery()가 해당 전략을 사용합니다.
 */
export class RawQueryBuilderFactory {
  private static factory: QueryBuilderFactoryFn = () => RawQueryBuilder.create();
  private static subFactory: QueryBuilderFactoryFn = () => RawQueryBuilder.subquery();

  /**
   * Sets a custom QueryBuilder strategy.
   * @param factory - Factory function for main queries
   * @param subFactory - Optional factory function for subqueries (defaults to factory)
   */
  static setStrategy(factory: QueryBuilderFactoryFn, subFactory?: QueryBuilderFactoryFn): void {
    RawQueryBuilderFactory.factory = factory;
    RawQueryBuilderFactory.subFactory = subFactory ?? factory;
  }

  /**
   * Resets to the default RawQueryBuilder strategy.
   */
  static resetStrategy(): void {
    RawQueryBuilderFactory.factory = () => RawQueryBuilder.create();
    RawQueryBuilderFactory.subFactory = () => RawQueryBuilder.subquery();
  }

  static create(): BaseRawQueryBuilder {
    return RawQueryBuilderFactory.factory();
  }

  static subquery(): BaseRawQueryBuilder {
    return RawQueryBuilderFactory.subFactory();
  }
}
