/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  Entity,
  Column,
  ManyToOne,
  RelationColumn,
  PrimaryGeneratedColumn,
} from "../../src/decorators";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

/**
 * A @ManyToOne is always the owning side, so its foreign-key column must be
 * resolvable from one of: @RelationColumn, an explicit `joinColumn` option, or
 * a `{prop}Id` @Column. When none of those exist the FK is silently dropped on
 * insert/update and the relation cannot be loaded. These tests lock in the
 * one-time (deduplicated) warning that surfaces the misconfiguration instead of
 * corrupting data quietly — and confirm correctly-backed relations stay quiet.
 */

@Entity()
class FkTarget {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity()
class BareManyToOne {
  @PrimaryGeneratedColumn()
  id!: number;

  // No @RelationColumn, no joinColumn option, no `targetId` @Column.
  @ManyToOne(() => FkTarget, () => undefined)
  target!: FkTarget;
}

@Entity()
class BackedByRelationColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => FkTarget, () => undefined)
  @RelationColumn({ name: "target_ref" })
  target!: FkTarget;
}

@Entity()
class BackedByIdColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  targetId!: number;

  @ManyToOne(() => FkTarget, () => undefined)
  target!: FkTarget;
}

function relsOf(entity: any) {
  return (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) ?? []) as any[];
}

function spyWarn(resolver: RelationMetadataResolver) {
  return jest
    .spyOn((resolver as any).logger, "warn")
    .mockImplementation(() => {});
}

describe("@ManyToOne unresolved foreign-key warning", () => {
  it("warns and leaves joinColumn unset when no FK backing exists", () => {
    const resolver = new RelationMetadataResolver();
    const warn = spyWarn(resolver);

    const resolved = resolver.resolveJoinColumnsFromColumnMeta(
      BareManyToOne as any,
      relsOf(BareManyToOne),
    );

    expect(resolved[0].joinColumn).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("no resolvable foreign-key");
    expect(msg).toContain("BareManyToOne");
    expect(msg).toContain("targetId");
  });

  it("does NOT warn when @RelationColumn provides the FK name", () => {
    const resolver = new RelationMetadataResolver();
    const warn = spyWarn(resolver);

    const resolved = resolver.resolveJoinColumnsFromColumnMeta(
      BackedByRelationColumn as any,
      relsOf(BackedByRelationColumn),
    );

    expect(resolved[0].joinColumn).toBe("target_ref");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn when a `{prop}Id` @Column backs the relation", () => {
    const resolver = new RelationMetadataResolver();
    const warn = spyWarn(resolver);

    const resolved = resolver.resolveJoinColumnsFromColumnMeta(
      BackedByIdColumn as any,
      relsOf(BackedByIdColumn),
    );

    expect(resolved[0].joinColumn).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("deduplicates the warning across repeated resolution of the same relation", () => {
    const resolver = new RelationMetadataResolver();
    const warn = spyWarn(resolver);

    for (let i = 0; i < 5; i++) {
      resolver.resolveJoinColumnsFromColumnMeta(
        BareManyToOne as any,
        relsOf(BareManyToOne),
      );
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
