/**
 * *AndSelect hydration under overlapping ("underscore-prefix") join aliases.
 *
 * transformJoinedEntityRows() partitions each flat row by alias prefix
 * (`${alias}_`). When one alias is a textual prefix of another (e.g. `user`
 * and `user_profile`), a column such as `user_profile_id` is ambiguous: it
 * could be alias `user` column `profile_id`, or alias `user_profile` column
 * `id`. The builder sorts prefixes longest-first (SelectQueryBuilder.ts
 * ~line 4203-4208) so the more specific alias claims the column. These tests
 * craft the exact colliding row keys with a mock driver and assert each value
 * lands on the correct entity regardless of join order.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class AcUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;
}

@Entity()
class AcProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  bio!: string;
}

@Entity()
class AcRoot {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", nullable: true })
  accountId!: number | null;

  @Column({ type: "int", nullable: true })
  profileId!: number | null;

  @ManyToOne(
    () => AcUser,
    (e: any) => e.account,
    { joinColumn: "accountId" },
  )
  account!: AcUser | null;

  @ManyToOne(
    () => AcProfile,
    (e: any) => e.profile,
    { joinColumn: "profileId" },
  )
  profile!: AcProfile | null;
}

/**
 * Mock EM that returns a fixed set of rows for the main SELECT. m2o-only
 * joins do not trigger two-phase pagination, so getMany() flows straight
 * into transformJoinedEntityRows() with exactly these rows.
 */
function createMockEm(rows: any[]) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
      getDialect: () => "mysql",
    },
    async query<T>(): Promise<T[]> {
      return rows as T[];
    },
  } as unknown as EntityManager;
  return em;
}

// One flat row carrying the ambiguous `user_profile_*` keys alongside the
// shorter `user_*` keys for the other join.
const COLLIDING_ROW = {
  r_id: 1,
  r_accountId: 10,
  r_profileId: 20,
  user_id: 10,
  user_username: "alice",
  user_profile_id: 20,
  user_profile_bio: "hi",
};

describe("*AndSelect hydration — overlapping underscore aliases", () => {
  it("routes `user_profile_*` to the nested alias, not to `user` (join order: user, user_profile)", async () => {
    const data = await new SelectQueryBuilder<AcRoot>(
      AcRoot,
      "r",
      createMockEm([COLLIDING_ROW]),
    )
      .leftJoinRelationAndSelect("account", "user")
      .leftJoinRelationAndSelect("profile", "user_profile")
      .getMany();

    expect(data).toHaveLength(1);

    // `user`-aliased values land on `account`, and only those.
    expect(data[0].account).toBeInstanceOf(AcUser);
    expect(data[0].account!.id).toBe(10);
    expect(data[0].account!.username).toBe("alice");
    // The `user_profile_*` columns must NOT leak onto `account`.
    expect((data[0].account as any).bio).toBeUndefined();
    expect((data[0].account as any).profile_id).toBeUndefined();
    expect((data[0].account as any).profile_bio).toBeUndefined();

    // `user_profile`-aliased values land on `profile`.
    expect(data[0].profile).toBeInstanceOf(AcProfile);
    expect(data[0].profile!.id).toBe(20);
    expect(data[0].profile!.bio).toBe("hi");
  });

  it("disambiguates the same way irrespective of join declaration order", async () => {
    // Declare the more-specific alias first; longest-prefix sort, not
    // insertion order, must still drive the partitioning.
    const data = await new SelectQueryBuilder<AcRoot>(
      AcRoot,
      "r",
      createMockEm([COLLIDING_ROW]),
    )
      .leftJoinRelationAndSelect("profile", "user_profile")
      .leftJoinRelationAndSelect("account", "user")
      .getMany();

    expect(data).toHaveLength(1);
    expect(data[0].account!.id).toBe(10);
    expect(data[0].account!.username).toBe("alice");
    expect(data[0].profile!.id).toBe(20);
    expect(data[0].profile!.bio).toBe("hi");
  });
});
