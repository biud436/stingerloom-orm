import { RawQueryBuilder } from "./RawQueryBuilder";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";

export type QueryBuilderFactoryFn = () => BaseRawQueryBuilder;

/**
 * Factory class for creating RawQueryBuilder instances.
 *
 * When a custom QueryBuilder strategy is registered via setStrategy(),
 * create()/subquery() will use that strategy.
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
