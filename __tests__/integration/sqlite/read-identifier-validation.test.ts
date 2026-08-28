/**
 * Read-path column identifier validation (V4-T2-3).
 *
 * `where` / `orderBy` / `select` / `groupBy` resolve a key through the
 * property-to-column map and fall back to the raw key when it is not there, so
 * a typo travelled to the driver and returned a dialect-specific error that
 * named the identifier but never the alternatives ("no such column: firstNam"
 * on SQLite) — while the same typo in bulk-write criteria already answered
 * with "Valid columns: ...". These cases pin the guard AND the fallback users
 * that must keep working: the columns of a sibling class in a single-table
 * hierarchy, the discriminator column, DB column names typed directly, and FK
 * shadow properties.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { Relation } from "../../../src/types/Relation";

@Entity({ name: "riv_teams" })
class RivTeam {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60, name: "team_name" })
  teamName!: string;
}

@Entity({ name: "riv_members" })
class RivMember {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  firstName!: string;

  @Column({ type: "int", nullable: true })
  teamId?: number;

  @ManyToOne(() => RivTeam, (t: RivTeam) => t.id, { joinColumn: "teamId" })
  team!: Relation<RivTeam>;
}

@Entity({ name: "riv_payments" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype", type: "varchar", length: 30 })
class RivPayment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  amount!: number;
}

@Entity()
@DiscriminatorValue("card")
class RivCardPayment extends RivPayment {
  @Column({ type: "varchar", length: 30, nullable: true })
  cardNumber!: string;
}

async function captureError(run: () => Promise<unknown>): Promise<InvalidQueryError> {
  try {
    await run();
  } catch (error) {
    return error as InvalidQueryError;
  }
  throw new Error("expected the query to reject, but it resolved");
}

describe("[Integration] SQLite: read-path column identifier validation", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [RivTeam, RivMember, RivPayment, RivCardPayment],
    });
    const team = await em.save(RivTeam, { teamName: "core" });
    await em.save(RivMember, { firstName: "kim", teamId: team.id });
    await em.save(RivCardPayment, { amount: 10, cardNumber: "4111" });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  describe("fail-fast on unknown identifiers", () => {
    it("rejects a where typo with the closest match and the valid list", async () => {
      const error = await captureError(() =>
        em.find(RivMember, { where: { firstNam: "kim" } as never }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Unknown column "firstNam" in "where" for entity "RivMember". Did you mean "firstName"?',
      );
      // The suggestion is merged into message so non-CLI consumers see it too.
      expect(error.message).toContain("\nSuggestion: Valid columns: ");
      expect(error.suggestion).toContain("Valid columns: ");
      expect(error.suggestion).toContain("firstName");
    });

    it("rejects an orderBy typo", async () => {
      const error = await captureError(() =>
        em.find(RivMember, { orderBy: { firstNam: "ASC" } as never }),
      );
      expect(error.message).toContain('Unknown column "firstNam" in "orderBy"');
    });

    it("rejects a select typo, in both array and record form", async () => {
      const fromArray = await captureError(() =>
        em.find(RivMember, { select: ["firstNam"] as never }),
      );
      expect(fromArray.message).toContain('Unknown column "firstNam" in "select"');

      const fromRecord = await captureError(() =>
        em.find(RivMember, { select: { firstNam: true } as never }),
      );
      expect(fromRecord.message).toContain('Unknown column "firstNam" in "select"');
    });

    it("rejects a groupBy typo", async () => {
      const error = await captureError(() =>
        em.find(RivMember, { groupBy: ["firstNam"] as never }),
      );
      expect(error.message).toContain('Unknown column "firstNam" in "groupBy"');
    });

    it("checks keys nested under AND / OR / NOT", async () => {
      const inOr = await captureError(() =>
        em.find(RivMember, {
          where: { OR: [{ firstName: "kim" }, { firstNam: "lee" }] } as never,
        }),
      );
      expect(inOr.message).toContain('Unknown column "firstNam" in "where"');

      const inNot = await captureError(() =>
        em.find(RivMember, { where: { NOT: { firstNam: "kim" } } as never }),
      );
      expect(inNot.message).toContain('Unknown column "firstNam"');

      const inArray = await captureError(() =>
        em.find(RivMember, { where: [{ firstName: "kim" }, { firstNam: "x" }] as never }),
      );
      expect(inArray.message).toContain('Unknown column "firstNam"');
    });

    it("rejects a relation property used as a where key", async () => {
      // `team` is a relation, not a column — keyof T let it through the type
      // check and it used to reach the driver as a raw identifier.
      const error = await captureError(() =>
        em.find(RivMember, { where: { team: { id: 1 } } as never }),
      );
      expect(error.message).toContain('Unknown column "team" in "where"');
    });

    it("guards cursor pagination's where and sort column", async () => {
      const inWhere = await captureError(() =>
        em.findWithCursor(RivMember, { where: { firstNam: "kim" } as never }),
      );
      expect(inWhere.message).toContain('Unknown column "firstNam" in "where"');

      const inOrderBy = await captureError(() =>
        em.findWithCursor(RivMember, { orderBy: "firstNam" as never }),
      );
      expect(inOrderBy.message).toContain('Unknown column "firstNam" in "orderBy"');
    });

    it("guards the aggregate path the same way", async () => {
      const inWhere = await captureError(() =>
        em.count(RivMember, { firstNam: "kim" } as never),
      );
      expect(inWhere.message).toContain('Unknown column "firstNam" in "where"');

      const inField = await captureError(() => em.sum(RivMember, "amont" as never));
      expect(inField.message).toContain('Unknown column "amont" in "select"');
    });
  });

  describe("no regression for the raw-name fallback users", () => {
    it("accepts a DB column name that differs from the property name", async () => {
      const byProperty = await em.find(RivTeam, { where: { teamName: "core" } });
      const byColumn = await em.find(RivTeam, { where: { team_name: "core" } as never });

      expect(byProperty).toHaveLength(1);
      expect(byColumn).toHaveLength(1);
    });

    it("accepts an FK shadow property", async () => {
      const rows = await em.find(RivMember, { where: { teamId: 1 }, orderBy: { teamId: "ASC" } });
      expect(rows).toHaveLength(1);
    });

    it("accepts a child class column and the discriminator on a single-table root query", async () => {
      const byChildColumn = await em.find(RivPayment, {
        where: { cardNumber: "4111" } as never,
        orderBy: { cardNumber: "ASC" } as never,
      });
      expect(byChildColumn).toHaveLength(1);

      const byDiscriminator = await em.find(RivPayment, {
        where: { ptype: "card" } as never,
      });
      expect(byDiscriminator).toHaveLength(1);
    });

    it("accepts a where value of undefined for an unknown key (resolver skips it)", async () => {
      const rows = await em.find(RivMember, {
        where: { firstName: "kim", firstNam: undefined } as never,
      });
      expect(rows).toHaveLength(1);
    });

    it("keeps cursor pagination working on a valid column", async () => {
      const page = await em.findWithCursor(RivMember, {
        orderBy: "id",
        take: 10,
      });
      expect(page.data).toHaveLength(1);
    });

    it("keeps aggregates over a valid column working", async () => {
      expect(await em.count(RivMember)).toBe(1);
      expect(await em.sum(RivPayment, "amount")).toBe(10);
    });
  });
});
