/**
 * Root entity-scope enforcement (V4-T2-4).
 *
 * Decorator side effects register metadata globally, so an entity missing
 * from a scoped connection's `entities` array still resolved metadata fine
 * and only died on the first SQL with a raw driver error ("no such table") —
 * the schema sync had correctly skipped its DDL. Root API entry points now
 * throw EntityMetadataNotFoundError naming the connection and the fix.
 *
 * Also pins the two sanctioned allowances:
 * - inheritance relatives (STI child of a scoped parent, and vice versa) are
 *   polymorphic queries against tables the connection owns;
 * - cascade traversal reaches relation targets through the public facades but
 *   is scope-exempt, so an attach()ed EM scoped to a subset keeps cascading.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { EntityMetadataNotFoundError } from "../../../src/errors/EntityMetadataNotFoundError";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { Relation } from "../../../src/types/Relation";

@Entity({ name: "esf_users" })
class EsfUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  name!: string;
}

// Decorated and imported, but never listed in the scoped connection's entities.
@Entity({ name: "esf_outside" })
class EsfOutside {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  label!: string;
}

@Entity({ name: "esf_parents" })
class EsfParent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  name!: string;

  @OneToMany(() => EsfChild, { mappedBy: "parent", cascade: ["insert"] })
  children?: EsfChild[];
}

@Entity({ name: "esf_children" })
class EsfChild {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  title!: string;

  @Column({ type: "int", nullable: true })
  parentId?: number;

  @ManyToOne(() => EsfParent, (p: EsfParent) => p.id, { joinColumn: "parentId" })
  parent!: Relation<EsfParent>;
}

@Entity({ name: "esf_payments" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype", type: "varchar", length: 30 })
class EsfPayment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  amount!: number;
}

@Entity()
@DiscriminatorValue("card")
class EsfCardPayment extends EsfPayment {
  @Column({ type: "varchar", length: 30, nullable: true })
  cardNumber?: string;
}

afterAll(async () => {
  await DatabaseClient.getInstance().close();
});

describe("[Integration] SQLite: root entity-scope fail-fast", () => {
  it("rejects an out-of-scope entity with the connection name instead of a raw driver error", async () => {
    const em = await createTestEntityManager({
      entities: [EsfUser],
      connectionName: "esf_scoped",
    });

    await expect(em.find(EsfOutside, {})).rejects.toThrow(
      EntityMetadataNotFoundError,
    );
    await expect(em.find(EsfOutside, {})).rejects.toThrow(
      /not registered on connection "esf_scoped".*"entities" array/s,
    );
    await expect(em.save(EsfOutside, { label: "x" })).rejects.toThrow(
      EntityMetadataNotFoundError,
    );
    await expect(em.count(EsfOutside)).rejects.toThrow(
      EntityMetadataNotFoundError,
    );
    expect(() => em.getRepository(EsfOutside)).toThrow(
      EntityMetadataNotFoundError,
    );
    expect(() => em.createQueryBuilder(EsfOutside, "o")).toThrow(
      EntityMetadataNotFoundError,
    );

    // The scoped entity itself keeps working.
    await em.save(EsfUser, { name: "Ada" });
    await expect(em.find(EsfUser, {})).resolves.toHaveLength(1);
  });

  it("keeps every entity allowed on an unscoped (empty entities) connection", async () => {
    const em = await createTestEntityManager({
      entities: [],
      connectionName: "esf_unscoped",
    });

    // Unscoped sync creates every globally-known table, so this resolves.
    await expect(em.find(EsfOutside, {})).resolves.toEqual([]);
  });

  it("allows inheritance relatives of scoped classes (STI, both directions)", async () => {
    const em = await createTestEntityManager({
      entities: [EsfPayment],
      connectionName: "esf_sti",
    });

    // Child of a scoped parent: polymorphic query on the parent's table.
    await expect(em.find(EsfCardPayment, {})).resolves.toEqual([]);

    // Parent of a scoped child, through an attach()ed subset scope.
    const emChildOnly = new EntityManager();
    await emChildOnly.attach("esf_sti", { entities: [EsfCardPayment] });
    await expect(emChildOnly.find(EsfPayment, {})).resolves.toEqual([]);
  });

  it("exempts cascade traversal: an attach()ed subset scope still cascades, but blocks root use", async () => {
    const emFull = await createTestEntityManager({
      entities: [EsfParent, EsfChild],
      connectionName: "esf_cascade",
    });

    const emSubset = new EntityManager();
    await emSubset.attach("esf_cascade", { entities: [EsfParent] });

    // Cascade insert reaches EsfChild through the public save facade — exempt.
    await emSubset.save(EsfParent, {
      name: "p1",
      children: [{ title: "c1" }, { title: "c2" }] as EsfChild[],
    });

    const children = await emFull.find(EsfChild, {});
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentId !== null && c.parentId !== undefined)).toBe(true);

    // Root use of the same out-of-scope entity still fails fast.
    await expect(emSubset.find(EsfChild, {})).rejects.toThrow(
      EntityMetadataNotFoundError,
    );
  });

  it("carries the ENTITY_METADATA_NOT_FOUND code and an entities-array suggestion", async () => {
    const em = await createTestEntityManager({
      entities: [EsfUser],
      connectionName: "esf_code",
    });

    let caught: unknown;
    try {
      await em.findOne(EsfOutside, { where: { id: 1 } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.ENTITY_METADATA_NOT_FOUND);
    expect((caught as OrmError).suggestion).toMatch(/"entities" array/);
  });
});
