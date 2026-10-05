/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Expose } from "class-transformer";
import { Column, Entity, ManyToOne, PrimaryColumn } from "../../../src/decorators";
import {
  ResultTransformer,
  joinedSubclassRow,
  type RowClassifier,
} from "../../../src/core/ResultTransformer";
import type { QueryResult } from "../../../src/types";

/**
 * A JOINed relation whose target is the root of a hierarchy is built
 * through the classifier `joined` maps it to: the class the row names, with
 * the row the classifier cut. A relation without one keeps its declared
 * class.
 */
describe("ResultTransformer / JOINed relations to a hierarchy root", () => {
  @Entity()
  class Asset {
    @Expose() @PrimaryColumn({ type: "int", name: "id" }) id!: number;
    @Expose() @Column({ type: "varchar", name: "label" }) label!: string;
  }

  @Entity()
  class Car extends Asset {
    @Expose() @Column({ type: "int", name: "wheel_count" }) wheelCount!: number;
  }

  @Entity()
  class Owner {
    @Expose() @PrimaryColumn({ type: "int", name: "id" }) id!: number;
  }

  @Entity()
  class Holder {
    @Expose() @PrimaryColumn({ type: "int", name: "id" }) id!: number;
    @Expose() @ManyToOne(() => Asset, undefined as any) asset?: Asset | null;
    @Expose() @ManyToOne(() => Owner, undefined as any) owner?: Owner | null;
  }

  const rt = new ResultTransformer();

  it("builds the relation as the class the classifier picks, from the row it cuts", () => {
    const seen: Array<Record<string, any>> = [];
    const classify: RowClassifier = (row) => {
      seen.push(row);
      const { dtype: _dtype, ...rest } = row;
      return { entityClass: Car, row: rest };
    };
    const result: QueryResult = {
      results: [
        { id: 1, asset__id: 5, asset__label: "car", asset__dtype: "car", asset__wheel_count: 4, owner__id: 9 },
      ],
    };
    const holder = rt.transformNested(
      Holder,
      result,
      undefined,
      new Map([
        ["asset", classify],
        ["owner", undefined],
      ]),
    ) as Holder;

    expect(seen).toEqual([{ id: 5, label: "car", dtype: "car", wheel_count: 4 }]);
    expect(holder.asset).toBeInstanceOf(Car);
    expect(holder.asset).toMatchObject({ id: 5, label: "car", wheelCount: 4 });
    expect("dtype" in holder.asset!).toBe(false);
    expect(holder.owner).toBeInstanceOf(Owner);
  });

  it("leaves a LEFT JOIN miss null without classifying it", () => {
    const classify = jest.fn<ReturnType<RowClassifier>, Parameters<RowClassifier>>();
    const holder = rt.transformNested(
      Holder,
      { results: [{ id: 1, asset__id: null, asset__label: null, asset__dtype: null }] },
      undefined,
      new Map([["asset", classify]]),
    ) as Holder;
    expect(holder.asset).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("joinedSubclassRow", () => {
  const row = {
    id: 1,
    label: "car",
    dtype: "car",
    cars_wheels: 4,
    boats_sails: null,
    owner__id: 7,
  };

  it("keeps the root's columns and the named subclass's under their bare names", () => {
    expect(joinedSubclassRow(row, "dtype", "cars", ["cars", "boats"])).toEqual({
      id: 1,
      label: "car",
      wheels: 4,
      owner__id: 7,
    });
  });

  it("drops every subclass's columns for a row of the root itself", () => {
    expect(joinedSubclassRow(row, "dtype", undefined, ["cars", "boats"])).toEqual({
      id: 1,
      label: "car",
      owner__id: 7,
    });
  });
});
