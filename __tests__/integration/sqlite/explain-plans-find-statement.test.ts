/**
 * explain() plans the statement find() runs.
 *
 * It used to assemble a statement of its own that knew nothing about
 * inheritance or joins: a TABLE_PER_CLASS root was planned as a scan of the
 * root table alone, a JOINED child without its root, an eager to-one without
 * its join — and a column the read resolves through one of those sources
 * failed with the driver's "no such column".
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorValue,
  ManyToOne,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import type { EntityManager } from "../../../src";

@Entity({ name: "epf_owner" })
class EpfOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) name!: string;
}

@Entity({ name: "epf_asset" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
class EpfAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) label!: string;
}

@Entity({ name: "epf_house" })
class EpfHouse extends EpfAsset {
  @Column({ type: "int", nullable: true }) floors?: number;
}

@Entity({ name: "epf_doc" })
@Inheritance({ strategy: "JOINED" })
class EpfDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) title!: string;
}

@Entity({ name: "epf_memo" })
class EpfMemo extends EpfDoc {
  @Column({ type: "varchar", nullable: true }) body?: string;
}

@Entity({ name: "epf_pay" })
@Inheritance({ strategy: "SINGLE_TABLE" })
class EpfPay {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}

@Entity()
@DiscriminatorValue("card")
class EpfCard extends EpfPay {
  @Column({ type: "varchar", nullable: true }) num?: string;
}

@Entity({ name: "epf_pet" })
class EpfPet {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => EpfOwner, (o: any) => o.id, { joinColumn: "owner_id", eager: true })
  owner!: EpfOwner;
}

@Entity({ name: "epf_toy" })
class EpfToy {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => EpfOwner, (o: any) => o.id, { joinColumn: "owner_id" })
  owner!: EpfOwner;
}

describe("[Integration] SQLite: explain() plans the statement find() runs", () => {
  let em: EntityManager;

  const plan = async (run: Promise<{ raw: unknown }>): Promise<string> =>
    ((await run).raw as Array<{ detail: string }>).map((row) => row.detail).join(" | ");

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [EpfOwner, EpfAsset, EpfHouse, EpfDoc, EpfMemo, EpfPay, EpfCard, EpfPet, EpfToy],
      connectionName: "epf",
    });
  });

  afterAll(async () => {
    await DatabaseClient.getInstance().close();
  });

  it("plans every table of a TABLE_PER_CLASS root", async () => {
    const detail = await plan(em.explain(EpfAsset, {}));
    expect(detail).toContain("epf_asset");
    expect(detail).toContain("epf_house");
  });

  it("accepts a subclass column on a TABLE_PER_CLASS root", async () => {
    const detail = await plan(em.explain(EpfAsset, { where: { floors: 2 } as any }));
    expect(detail).toContain("epf_house");
  });

  it("joins the child tables of a JOINED root", async () => {
    const detail = await plan(em.explain(EpfDoc, {}));
    expect(detail).toContain("epf_doc");
    expect(detail).toContain("epf_memo");
  });

  it("accepts a subclass column on a JOINED root", async () => {
    const detail = await plan(em.explain(EpfDoc, { where: { body: "x" } as any }));
    expect(detail).toContain("epf_memo");
  });

  it("joins the root table of a JOINED child and accepts an inherited column", async () => {
    const detail = await plan(em.explain(EpfMemo, { where: { title: "t" } as any }));
    expect(detail).toContain("epf_doc");
    expect(detail).toContain("epf_memo");
  });

  it("plans a SINGLE_TABLE child on the shared table", async () => {
    const detail = await plan(em.explain(EpfCard, { where: { num: "41" } }));
    expect(detail).toContain("epf_pay");
  });

  it("joins an eager to-one relation", async () => {
    const detail = await plan(em.explain(EpfPet, {}));
    expect(detail).toContain("epf_pet");
    expect(detail).toContain("owner");
  });

  it("joins a requested to-one relation and leaves it out otherwise", async () => {
    expect(await plan(em.explain(EpfToy, {}))).not.toContain("owner");
    expect(await plan(em.explain(EpfToy, { relations: ["owner"] }))).toContain("owner");
  });

  it("returns what find() returns for the same options", async () => {
    await em.save(EpfHouse, { label: "h", floors: 2 });
    await em.save(EpfAsset, { label: "a" });
    const rows = await em.find(EpfAsset, { where: { floors: 2 } as any });
    expect(rows).toHaveLength(1);
    await expect(em.explain(EpfAsset, { where: { floors: 2 } as any })).resolves.toBeDefined();
  });
});
