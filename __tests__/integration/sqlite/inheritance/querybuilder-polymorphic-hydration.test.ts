/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: SelectQueryBuilder rows of a polymorphic SINGLE_TABLE root
 * become entities the way find() builds them.
 *
 * The polymorphic branch handed each row to the deserializer directly, so a
 * column mapped to another name (`@Column({ name })`, a NamingStrategy) or a
 * relation's join column stayed under its DB name — `amount` was undefined,
 * `pay_amount` held the value — and the columns of a relation joined with
 * `loadRelation()` / `*AndSelect` were left as raw `payer_name` / `p_id`
 * keys: the branch ran before the joined-selection hydration.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  ManyToOne,
  RelationColumn,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "qph_payer" })
class QphPayer {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "qph_pay" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype" })
class QphPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: "pay_amount" }) amount!: number;
  @ManyToOne(() => QphPayer, (p: any) => p.payments)
  @RelationColumn({ name: "payer_id" })
  payer!: QphPayer | null;
}

@Entity()
@DiscriminatorValue("card")
class QphCard extends QphPayment {
  @Column({ nullable: true }) last4!: string;
}

describe("[Integration] SQLite: SelectQueryBuilder polymorphic hydration", () => {
  let em: EntityManager;
  let payer: QphPayer;

  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  beforeEach(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [QphPayer, QphPayment, QphCard],
        synchronize: true,
        logging: false,
      } as any,
      `qph_${Math.random().toString(36).slice(2, 10)}`,
    );
    payer = await em.save(QphPayer, { name: "ann" } as any);
    await em.save(QphCard, { amount: 5, last4: "1234", payer } as any);
    await em.save(QphPayment, { amount: 7, payer } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("maps renamed columns and join columns back to their properties", async () => {
    const rows = await em
      .createQueryBuilder(QphPayment, "p")
      .orderBy({ id: "ASC" } as any)
      .getMany();

    expect(rows.map((r) => r.constructor)).toEqual([QphCard, QphPayment]);
    expect(rows.map((r) => [r.amount, (r as any).payerId])).toEqual([
      [5, payer.id],
      [7, payer.id],
    ]);
    expect(plain(rows[0])).not.toHaveProperty("pay_amount");
    expect(plain(rows[0])).not.toHaveProperty("payer_id");
  });

  it("hydrates a joined relation into each subclass instance", async () => {
    const loaded = await (em.createQueryBuilder(QphPayment, "p") as any)
      .loadRelation("payer")
      .orderBy({ id: "ASC" })
      .getMany();
    const joined = await (em.createQueryBuilder(QphPayment, "p") as any)
      .leftJoinRelationAndSelect("payer", "o")
      .orderBy({ id: "ASC" })
      .getMany();

    for (const rows of [loaded, joined]) {
      expect(rows.map((r: any) => [r.constructor, r.amount, r.payerId, r.payer?.name])).toEqual([
        [QphCard, 5, payer.id, "ann"],
        [QphPayment, 7, payer.id, "ann"],
      ]);
      expect(plain(rows[0])).not.toHaveProperty("payer_name");
      expect(plain(rows[0])).not.toHaveProperty("o_id");
    }
  });

  it("agrees with find() on the same root", async () => {
    const viaFind = await em.find(QphPayment, {
      relations: ["payer"],
      orderBy: { id: "ASC" },
    } as any);
    const viaBuilder = await (em.createQueryBuilder(QphPayment, "p") as any)
      .loadRelation("payer")
      .orderBy({ id: "ASC" })
      .getMany();

    expect(plain(viaBuilder)).toEqual(plain(viaFind));
  });
});
