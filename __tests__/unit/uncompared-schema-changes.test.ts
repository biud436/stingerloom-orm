/**
 * The notices `synchronize` and `migrate:generate` log about what they do not
 * compare on an existing table list only the kinds the entities can run into.
 * The SQLite integration test covers the logging itself; this pins the
 * dialect-specific kinds and the code-first entry point.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  defineEntity,
  t,
} from "../../src";
import {
  describeGenerateGaps,
  describeSynchronizeGaps,
} from "../../src/core/generators/uncomparedSchemaChanges";

@Entity({ name: "ucsc_ticket" })
class Ticket {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "enum", enumValues: ["open", "closed"] }) status!: string;
}

@Entity({ name: "ucsc_owner" })
class Owner {
  @PrimaryGeneratedColumn() id!: number;
}

@Entity({ name: "ucsc_pet" })
class Pet {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => Owner, () => undefined)
  @RelationColumn({ name: "owner_id" })
  owner!: Owner;
}

@Entity({ name: "ucsc_profile" })
class Profile {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => Owner, { onDelete: "SET NULL" })
  @RelationColumn({ name: "owner_id" })
  owner!: Owner;
}

const kindsOf = (notice: string) =>
  notice.slice(notice.indexOf(": ") + 2, notice.indexOf(". "));

describe("uncompared schema change notices", () => {
  it("lists ENUM value lists on MySQL only, where the values live in the column type", () => {
    expect(kindsOf(describeSynchronizeGaps([Ticket], "mysql"))).toBe(
      "removed or redefined indexes, changed ENUM value lists",
    );
    expect(kindsOf(describeSynchronizeGaps([Ticket], "postgres"))).toBe(
      "removed or redefined indexes",
    );
  });

  it("lists missing foreign key constraints for synchronize on SQLite only", () => {
    expect(kindsOf(describeSynchronizeGaps([Owner, Pet], "sqlite"))).toBe(
      "removed or redefined indexes, foreign key constraints for relations added to an existing table",
    );
    expect(kindsOf(describeSynchronizeGaps([Owner, Pet], "postgres"))).toBe(
      "removed or redefined indexes",
    );
    // migrate:generate adds no constraint to an existing table on any dialect.
    expect(kindsOf(describeGenerateGaps([Owner, Pet], "postgres"))).toBe(
      "new indexes and foreign key constraints, removed or redefined indexes",
    );
  });

  it("counts an owning @OneToOne's onDelete", () => {
    expect(kindsOf(describeSynchronizeGaps([Owner, Profile], "mysql"))).toBe(
      "changed foreign key onDelete/onUpdate, removed or redefined indexes",
    );
  });

  it("reads defineEntity() declarations", () => {
    const Order = defineEntity("ucsc_order", {
      id: t.int().primary().generated(),
      state: t.varchar(20).default("new"),
    });

    expect(kindsOf(describeSynchronizeGaps([Order], "postgres"))).toBe(
      "changed column defaults, removed or redefined indexes",
    );
  });
});
