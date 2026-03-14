import { RawQueryBuilderFactory } from "../../src/core/RawQueryBuilderFactory";
import { RawQueryBuilder } from "../../src/core/RawQueryBuilder";
import { BaseRawQueryBuilder } from "../../src/core/BaseRawQueryBuilder";

describe("RawQueryBuilderFactory strategy pattern", () => {
  afterEach(() => {
    RawQueryBuilderFactory.resetStrategy();
  });

  it("default factory returns RawQueryBuilder instance", () => {
    const qb = RawQueryBuilderFactory.create();
    expect(qb).toBeDefined();
    expect(qb).toBeInstanceOf(RawQueryBuilder);
  });

  it("default subquery returns RawQueryBuilder instance", () => {
    const qb = RawQueryBuilderFactory.subquery();
    expect(qb).toBeDefined();
    expect(qb).toBeInstanceOf(RawQueryBuilder);
  });

  it("setStrategy replaces the factory function", () => {
    const mockQb: BaseRawQueryBuilder = {
      setDatabaseType: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      whereBetween: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      join: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      rightJoin: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      appendSql: jest.fn().mockReturnThis(),
      as: jest.fn(),
      asInQuery: jest.fn(),
      asExists: jest.fn(),
      build: jest.fn(),
    };

    const factory = jest.fn(() => mockQb);
    RawQueryBuilderFactory.setStrategy(factory);

    const result = RawQueryBuilderFactory.create();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toBe(mockQb);

    // subquery also uses the same factory when no subFactory provided
    const sub = RawQueryBuilderFactory.subquery();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(sub).toBe(mockQb);
  });

  it("setStrategy with separate subFactory", () => {
    const mainQb = { marker: "main" } as unknown as BaseRawQueryBuilder;
    const subQb = { marker: "sub" } as unknown as BaseRawQueryBuilder;

    RawQueryBuilderFactory.setStrategy(
      () => mainQb,
      () => subQb,
    );

    expect(RawQueryBuilderFactory.create()).toBe(mainQb);
    expect(RawQueryBuilderFactory.subquery()).toBe(subQb);
  });

  it("resetStrategy restores default factory", () => {
    const mockQb = {} as BaseRawQueryBuilder;
    RawQueryBuilderFactory.setStrategy(() => mockQb);

    // Before reset: custom
    expect(RawQueryBuilderFactory.create()).toBe(mockQb);

    // After reset: default
    RawQueryBuilderFactory.resetStrategy();
    const qb = RawQueryBuilderFactory.create();
    expect(qb).toBeInstanceOf(RawQueryBuilder);
  });
});
