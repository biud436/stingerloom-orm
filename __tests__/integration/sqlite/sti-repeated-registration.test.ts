/**
 * STI root survives repeated registrations (found while building V4-T2-4).
 *
 * registerEntities() injects the discriminator column into the STI root's
 * shared metadata in place, without a propertyKey. The NamingStrategy pass of
 * the NEXT register() then rewrote every non-explicit column name via
 * `columnName(col.propertyKey!)` — for the injected entry that is
 * `columnName(undefined)`, stripping the name. The second connection's
 * CREATE TABLE died on the nameless column (`undefined.replace` TypeError),
 * `continueOnError` degraded it to a warning, and the STI table silently
 * never existed on any EntityManager registered after the first.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";

@Entity({ name: "srr_payments" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype", type: "varchar", length: 30 })
class SrrPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}

@Entity()
@DiscriminatorValue("card")
class SrrCardPayment extends SrrPayment {
  @Column({ type: "varchar", length: 30, nullable: true }) cardNumber?: string;
}

afterAll(async () => {
  await DatabaseClient.getInstance().close();
});

describe("[Integration] SQLite: STI table survives repeated registrations", () => {
  it("creates the STI root table on a second connection registered after the first", async () => {
    const em1 = await createTestEntityManager({
      entities: [SrrPayment, SrrCardPayment],
      connectionName: "srr_first",
    });
    await em1.save(SrrCardPayment, { amount: 10, cardNumber: "41" });

    // The second register() runs the NamingStrategy pass over metadata the
    // first registerEntities() already mutated (injected discriminator).
    const em2 = await createTestEntityManager({
      entities: [SrrPayment, SrrCardPayment],
      connectionName: "srr_second",
    });

    const conn2 = DatabaseClient.getInstance().getConnection("srr_second");
    const tables = (await conn2.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='srr_payments'`,
    )) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    // And the second EM is fully usable, discriminator included.
    await em2.save(SrrCardPayment, { amount: 20, cardNumber: "42" });
    const rows = await em2.find(SrrCardPayment, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(20);

    // The first connection is untouched by the second registration.
    const rows1 = await em1.find(SrrCardPayment, {});
    expect(rows1).toHaveLength(1);
    expect(rows1[0].amount).toBe(10);
  });
});
