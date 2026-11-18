/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  OneToOne,
  Inheritance,
  DiscriminatorValue,
} from "../../src";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { validateRelationGraph } from "../../src/core/RelationGraphValidator";
import { CascadeHandler } from "../../src/core/CascadeHandler";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const resolver = new RelationMetadataResolver();

function problemsOf(scope: any[], connectionName?: string): string | null {
  try {
    validateRelationGraph(scope, resolver, connectionName);
    return null;
  } catch (e: any) {
    expect(e.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    return (e.message as string).split("\nSuggestion:")[0];
  }
}

// --- a valid graph -----------------------------------------------------------

@Entity({ name: "rgv_users" })
class RgvUser {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgvPost, { mappedBy: "author" }) posts?: RgvPost[];
  @OneToOne(() => RgvProfile, { inverseSide: "user" }) profile?: any;
}

@Entity({ name: "rgv_profiles" })
class RgvProfile {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => RgvUser, { joinColumn: "user_id" }) user?: any;
}

@Entity({ name: "rgv_posts" })
class RgvPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int", nullable: true, name: "author_id" }) authorId?: number;
  @ManyToOne(() => RgvUser, (u: RgvUser) => u.posts, { joinColumn: "author_id" }) author?: any;
  @ManyToMany(() => RgvTag, {
    joinTable: { name: "rgv_post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags?: RgvTag[];
}

@Entity({ name: "rgv_tags" })
class RgvTag {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvPost, { mappedBy: "tags" }) posts?: RgvPost[];
}

// A OneToMany naming the FK column instead of the ManyToOne property.
@Entity({ name: "rgv_boards" })
class RgvBoard {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgvCard, { mappedBy: "board_id" }) cards?: RgvCard[];
}

@Entity({ name: "rgv_cards" })
class RgvCard {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int", name: "board_id" }) boardId!: number;
}

const VALID = [RgvUser, RgvProfile, RgvPost, RgvTag, RgvBoard, RgvCard];

// --- misuses -----------------------------------------------------------------

@Entity({ name: "rgv_typo_users" })
class RgvTypoUser {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgvTypoPost, { mappedBy: "autor" }) posts?: RgvTypoPost[];
}

@Entity({ name: "rgv_typo_posts" })
class RgvTypoPost {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => RgvTypoUser, (u: RgvTypoUser) => u.posts, { joinColumn: "author_id" }) author?: any;
}

@Entity({ name: "rgv_orphan_lists" })
class RgvOrphanList {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgvCard, { mappedBy: "list" }) cards?: RgvCard[];
}

@Entity({ name: "rgv_m2m_a" })
class RgvM2mA {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvM2mB, {}) bs?: RgvM2mB[];
}

@Entity({ name: "rgv_m2m_b" })
class RgvM2mB {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvM2mA, { mappedBy: "bs" }) as?: RgvM2mA[];
}

@Entity({ name: "rgv_articles" })
class RgvArticle {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvInverseTag, {
    joinTable: { name: "rgv_article_tags", joinColumn: "article_id", inverseJoinColumn: "tag_id" },
  })
  labels?: RgvInverseTag[];
}

@Entity({ name: "rgv_inverse_tags" })
class RgvInverseTag {
  @PrimaryGeneratedColumn() id!: number;
  // The owning side declares the join table; this side forgot mappedBy.
  @ManyToMany(() => RgvArticle) articles?: RgvArticle[];
  @ManyToMany(() => RgvPost, { mappedBy: "tgs" }) posts?: RgvPost[];
}

@Entity({ name: "rgv_lockers" })
class RgvLocker {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => RgvKey, { inverseSide: "lockr" }) key?: any;
  @OneToOne(() => RgvKey, { inverseSide: "spare" }) spareKey?: any;
}

@Entity({ name: "rgv_keys" })
class RgvKey {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => RgvLocker, { joinColumn: "locker_id" }) locker?: any;
  @OneToOne(() => RgvLocker) spare?: any;
}

class RgvNotAnEntity {
  id!: number;
}

@Entity({ name: "rgv_loose" })
class RgvLoose {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => RgvNotAnEntity as any, (x: any) => x.id, { joinColumn: "x_id" }) plain?: any;
  @ManyToOne(() => undefined as any, (x: any) => x.id, { joinColumn: "y_id" }) early?: any;
}

// --- inheritance -------------------------------------------------------------

@Entity({ name: "rgv_vehicles" })
@Inheritance({ strategy: "SINGLE_TABLE" })
class RgvVehicle {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => RgvUser, (u: RgvUser) => u.id, { joinColumn: "owner_id" }) owner?: any;
}

@Entity()
@DiscriminatorValue("car")
class RgvCar extends RgvVehicle {
  @Column({ type: "int", nullable: true }) doors?: number;
}

@Entity({ name: "rgv_garages" })
class RgvGarage {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => RgvCar, (c: RgvCar) => c.id, { joinColumn: "car_id" }) car?: any;
}

// --- join table names --------------------------------------------------------

@Entity({ name: "rgv_jt_labels" })
class RgvJtLabel {
  @PrimaryGeneratedColumn() id!: number;
}

@Entity({ name: "rgv_jt_notes" })
class RgvJtNote {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvJtLabel, {
    joinTable: { name: "rgv_jt_shared", joinColumn: "note_id", inverseJoinColumn: "label_id" },
  })
  labels?: RgvJtLabel[];
}

// The join table option copied from RgvJtNote whole: same columns, another owner.
@Entity({ name: "rgv_jt_tasks" })
class RgvJtTask {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvJtLabel, {
    joinTable: { name: "rgv_jt_shared", joinColumn: "note_id", inverseJoinColumn: "label_id" },
  })
  labels?: RgvJtLabel[];
}

// The two sides of one relation, each declaring the table with its own column names.
@Entity({ name: "rgv_jt_boards" })
class RgvJtBoard {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvJtCard, {
    joinTable: { name: "rgv_jt_board_cards", joinColumn: "board_id", inverseJoinColumn: "card_id" },
  })
  cards?: RgvJtCard[];
}

@Entity({ name: "rgv_jt_cards" })
class RgvJtCard {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvJtBoard, {
    joinTable: { name: "rgv_jt_board_cards", joinColumn: "crd_id", inverseJoinColumn: "board_id" },
  })
  boards?: RgvJtBoard[];
}

@Entity({ name: "rgv_jt_people" })
class RgvJtPerson {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvJtPerson, {
    joinTable: { name: "rgv_jt_follows", joinColumn: "follower_id", inverseJoinColumn: "followee_id" },
  })
  following?: RgvJtPerson[];
  @ManyToMany(() => RgvJtPerson, {
    joinTable: { name: "rgv_jt_follows", joinColumn: "followee_id", inverseJoinColumn: "follower_id" },
  })
  followers?: RgvJtPerson[];
}

@Entity({ name: "rgv_jt_vehicles" })
@Inheritance({ strategy: "SINGLE_TABLE" })
class RgvJtVehicle {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgvJtLabel, {
    joinTable: { name: "rgv_jt_vehicle_labels", joinColumn: "vehicle_id", inverseJoinColumn: "label_id" },
  })
  labels?: RgvJtLabel[];
}

@Entity()
@DiscriminatorValue("van")
class RgvJtVan extends RgvJtVehicle {
  @Column({ type: "int", nullable: true }) seats?: number;
}

function joinTableProblemsOf(scope: any[], createsForeignKeys = true): string | null {
  try {
    validateRelationGraph(scope, resolver, undefined, { createsForeignKeys });
    return null;
  } catch (e: any) {
    expect(e.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    return (e.message as string).split("\nSuggestion:")[0];
  }
}

describe("validateRelationGraph: join table names", () => {
  it("rejects a join table option copied to another owner", () => {
    expect(joinTableProblemsOf([RgvJtLabel, RgvJtNote, RgvJtTask])).toBe(
      `Invalid relation mapping:\n` +
        `  - RgvJtTask.labels: @ManyToMany declares joinTable "rgv_jt_shared" with columns note_id (rgv_jt_tasks) and label_id (rgv_jt_labels), ` +
        `but RgvJtNote.labels already declares it with note_id (rgv_jt_notes) and label_id (rgv_jt_labels). ` +
        `Only one table of that name is created, so this relation would read and write the table built for the other. ` +
        `Give each relation its own join table name.`,
    );
  });

  it("suggests mappedBy when the two declarations join the same tables", () => {
    const message = joinTableProblemsOf([RgvJtBoard, RgvJtCard])!;
    expect(message).toContain(
      `RgvJtCard.boards: @ManyToMany declares joinTable "rgv_jt_board_cards" with columns crd_id (rgv_jt_cards) and board_id (rgv_jt_boards), ` +
        `but RgvJtBoard.cards already declares it with board_id (rgv_jt_boards) and card_id (rgv_jt_cards).`,
    );
    expect(message).toContain(
      `If the two are one relation seen from both sides, declare joinTable on one side and mappedBy on the other.`,
    );
  });

  it("accepts the two sides of a self relation declaring the table mirrored", () => {
    expect(joinTableProblemsOf([RgvJtPerson])).toBeNull();
  });

  it("accepts a relation an inheritance child reaches through its parent", () => {
    expect(joinTableProblemsOf([RgvJtVehicle, RgvJtVan, RgvJtLabel])).toBeNull();
  });

  it("does not check join tables when the ORM does not build the schema", () => {
    expect(joinTableProblemsOf([RgvJtLabel, RgvJtNote, RgvJtTask], false)).toBeNull();
  });
});

describe("validateRelationGraph", () => {
  it("accepts a graph whose every relation resolves", () => {
    expect(problemsOf(VALID)).toBeNull();
  });

  it("accepts a mappedBy that names the FK column instead of the ManyToOne", () => {
    expect(problemsOf([RgvBoard, RgvCard])).toBeNull();
  });

  it("names the ManyToOne a mappedBy typo meant", () => {
    expect(problemsOf([RgvTypoUser, RgvTypoPost], "main")).toBe(
      `Invalid relation mapping (connection "main"):\n` +
        `  - RgvTypoUser.posts: @OneToMany mappedBy "autor" names no @ManyToOne on RgvTypoPost. Did you mean "author"?`,
    );
  });

  it("says when the target has no ManyToOne pointing back", () => {
    expect(problemsOf([RgvOrphanList, RgvCard])).toContain(
      `RgvOrphanList.cards: @OneToMany mappedBy "list" names no @ManyToOne on RgvCard. RgvCard declares no @ManyToOne pointing back.`,
    );
  });

  it("rejects a ManyToMany pair where neither side declares the join table", () => {
    const message = problemsOf([RgvM2mA, RgvM2mB])!;
    expect(message).toContain(
      `RgvM2mA.bs: @ManyToMany declares neither joinTable nor mappedBy, so the relation has no join table. Declare joinTable on one side and mappedBy on the other.`,
    );
    expect(message).toContain(
      `RgvM2mB.as: @ManyToMany mappedBy "bs" names RgvM2mA.bs, which declares no joinTable either`,
    );
  });

  it("points an inverse ManyToMany without mappedBy at the owning side, and names a mappedBy typo", () => {
    const message = problemsOf([RgvInverseTag, RgvArticle, RgvPost, RgvUser, RgvTag, RgvProfile])!;
    expect(message).toContain(
      `RgvInverseTag.articles: @ManyToMany declares neither joinTable nor mappedBy, so the relation has no join table. RgvArticle.labels declares one: add mappedBy: "labels".`,
    );
    expect(message).toContain(
      `RgvInverseTag.posts: @ManyToMany mappedBy "tgs" names no @ManyToMany on RgvPost. Did you mean "tags"?`,
    );
  });

  it("checks a OneToOne inverseSide against the owning side", () => {
    const message = problemsOf([RgvLocker, RgvKey])!;
    expect(message).toContain(
      `RgvLocker.key: @OneToOne inverseSide "lockr" names no owning @OneToOne on RgvKey. Did you mean "locker"?`,
    );
    expect(message).toContain(
      `RgvLocker.spareKey: @OneToOne inverseSide "spare" names RgvKey.spare, which holds no join column either.`,
    );
  });

  it("rejects a target that is not an entity or not defined yet", () => {
    const message = problemsOf([RgvLoose])!;
    expect(message).toContain(
      `RgvLoose.plain: @ManyToOne targets RgvNotAnEntity, which is not an entity. Decorate it with @Entity().`,
    );
    expect(message).toContain(
      `RgvLoose.early: @ManyToOne targets undefined: the target class was not defined yet when the relation was read, usually because of a circular import.`,
    );
  });

  it("rejects a target outside the connection's entities, and accepts an inheritance relative", () => {
    expect(problemsOf([RgvPost, RgvTag])).toBe(
      `Invalid relation mapping:\n` +
        `  - RgvPost.author: @ManyToOne targets RgvUser, which is not in this connection's entities, so its table is never created. Add RgvUser to entities.`,
    );
    // RgvCar is a SINGLE_TABLE child of the listed RgvVehicle.
    expect(problemsOf([RgvGarage, RgvVehicle, RgvUser, RgvPost, RgvTag, RgvProfile])).toBeNull();
  });

  it("reports an inherited relation once", () => {
    const message = problemsOf([RgvVehicle, RgvCar])!;
    expect(message.match(/RgvVehicle\.owner/g)).toHaveLength(1);
  });

  it("checks every scanned entity when the connection lists none", () => {
    const message = problemsOf([])!;
    expect(message).toContain(`RgvTypoUser.posts: @OneToMany mappedBy "autor"`);
    expect(message).not.toContain("is not in this connection's entities");
  });
});

// --- write payloads ----------------------------------------------------------

@Entity({ name: "rgv_w_users" })
class RgvWUser {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgvWPost, { mappedBy: "author" }) posts?: RgvWPost[];
  @OneToMany(() => RgvWPost, { mappedBy: "editor", cascade: ["insert"] }) edited?: RgvWPost[];
}

@Entity({ name: "rgv_w_posts" })
class RgvWPost {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => RgvWUser, (u: RgvWUser) => u.posts, { joinColumn: "author_id" }) author?: any;
  @ManyToOne(() => RgvWUser, (u: RgvWUser) => u.edited, { joinColumn: "editor_id" }) editor?: any;
}

@Entity({ name: "rgv_w_lines" })
class RgvWLine {
  @PrimaryColumn({ type: "int" }) orderId!: number;
  @PrimaryColumn({ type: "int" }) seq!: number;
  @ManyToOne(() => RgvWOrder, (o: RgvWOrder) => o.lines, { joinColumn: "order_id" }) order?: any;
}

@Entity({ name: "rgv_w_orders" })
class RgvWOrder {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgvWLine, { mappedBy: "order" }) lines?: RgvWLine[];
}

describe("CascadeHandler.unwrittenRelationPayloads", () => {
  const handler = new CascadeHandler(resolver, {} as any);

  it("reports a new related row only a cascade the relation lacks would write", () => {
    expect(handler.unwrittenRelationPayloads(RgvWUser, [{ posts: [{ title: "p" }] }], true)).toEqual([
      { property: "posts", kind: "OneToMany" },
    ]);
    expect(handler.unwrittenRelationPayloads(RgvWUser, [{ edited: [{}] }], true)).toEqual([]);
    expect(handler.unwrittenRelationPayloads(RgvWPost, [{ author: { name: "new" } }], true)).toEqual([
      { property: "author", kind: "ManyToOne" },
    ]);
  });

  it("leaves rows that carry their key, scalar FKs and empty collections alone", () => {
    expect(
      handler.unwrittenRelationPayloads(RgvWUser, [{ posts: [{ id: 1 }, { id: 2 }] }, { posts: [] }], true),
    ).toEqual([]);
    expect(handler.unwrittenRelationPayloads(RgvWPost, [{ author: { id: 3 } }, { author: 3 }], true)).toEqual([]);
  });

  it("reports every relation when the method does not cascade", () => {
    expect(handler.unwrittenRelationPayloads(RgvWUser, [{ edited: [{}] }], false)).toEqual([
      { property: "edited", kind: "OneToMany" },
    ]);
  });

  it("counts a row missing one part of a composite key as new", () => {
    expect(handler.unwrittenRelationPayloads(RgvWOrder, [{ lines: [{ seq: 1 }] }], true)).toEqual([
      { property: "lines", kind: "OneToMany" },
    ]);
    expect(
      handler.unwrittenRelationPayloads(RgvWOrder, [{ lines: [{ orderId: 1, seq: 1 }] }], true),
    ).toEqual([]);
  });
});
