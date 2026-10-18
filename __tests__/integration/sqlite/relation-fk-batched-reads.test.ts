/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The batched reads that match related rows to each parent by an FK column
 * holding the parent's key — OneToMany children and the inverse side of a
 * OneToOne — apply the same predicates to the related entity: its
 * soft-delete column (lifted by `withDeleted`, read-wide or per relation)
 * and, under `tenant_column`, the active tenant (SQLite :memory:).
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Relation } from "../../../src/types/Relation";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";

@Entity({ name: "rfk_users" })
class RfkUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;

  @OneToOne(() => RfkAvatar, { inverseSide: "owner" })
  avatar!: Relation<RfkAvatar> | null;

  @OneToMany(() => RfkNote, { mappedBy: "user" })
  notes!: Relation<RfkNote>[];
}

@Entity({ name: "rfk_avatars" })
class RfkAvatar {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) url!: string;

  @OneToOne(() => RfkUser)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<RfkUser> | null;

  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "rfk_notes" })
class RfkNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) body!: string;

  @ManyToOne(() => RfkUser, (u: any) => u.notes)
  @RelationColumn({ name: "user_id", nullable: true })
  user!: Relation<RfkUser> | null;

  @DeletedAt() deletedAt!: Date | null;
}

const ENTITIES = [RfkUser, RfkAvatar, RfkNote];

async function makeEm(opts: Record<string, any> = {}): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      ...opts,
    },
    `rfk_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

const RELATIONS = ["avatar", "notes"];

function shapeOf(user: any) {
  return {
    avatar: user.avatar?.url ?? null,
    notes: (user.notes as any[]).map((n) => n.body).sort(),
  };
}

describe("[Integration] SQLite: batched FK reads (OneToMany, inverse OneToOne)", () => {
  beforeEach(() => MetadataContext.reset());

  describe("soft delete", () => {
    let em: EntityManager;
    let userId: number;

    beforeAll(async () => {
      em = await makeEm();
      const user = await em.save(RfkUser, { name: "alice" } as any);
      userId = user.id;
      await em.query(
        `INSERT INTO rfk_avatars (url, owner_id, deletedAt) VALUES ('gone.png', ?, '2026-01-01 00:00:00')`,
        [userId],
      );
      await em.query(`INSERT INTO rfk_notes (body, user_id) VALUES ('kept', ?)`, [userId]);
      await em.query(
        `INSERT INTO rfk_notes (body, user_id, deletedAt) VALUES ('trashed', ?, '2026-01-01 00:00:00')`,
        [userId],
      );
    });

    afterAll(async () => {
      await em.propagateShutdown({ closeConnections: true });
    });

    it("leaves a soft-deleted counterpart out of both relations", async () => {
      const user = await em.findOne(RfkUser, { where: { id: userId }, relations: RELATIONS });
      expect(shapeOf(user)).toEqual({ avatar: null, notes: ["kept"] });
    });

    it("brings it back in both under a read-wide withDeleted", async () => {
      const user = await em.findOne(RfkUser, {
        where: { id: userId },
        relations: RELATIONS,
        withDeleted: true,
      });
      expect(shapeOf(user)).toEqual({ avatar: "gone.png", notes: ["kept", "trashed"] });
    });

    it("brings it back in both under a per-relation withDeleted", async () => {
      const user = await em.findOne(RfkUser, {
        where: { id: userId },
        relations: { avatar: { withDeleted: true }, notes: { withDeleted: true } },
      } as any);
      expect(shapeOf(user)).toEqual({ avatar: "gone.png", notes: ["kept", "trashed"] });
    });
  });

  describe("tenant_column", () => {
    let em: EntityManager;

    beforeAll(async () => {
      em = await makeEm({ tenantStrategy: "tenant_column" });
    });

    afterAll(async () => {
      await em.propagateShutdown({ closeConnections: true });
    });

    it("never loads another tenant's rows that point at this tenant's parent", async () => {
      let acmeUserId!: number;
      await MetadataContext.run("acme", async () => {
        const user = await em.save(RfkUser, { name: "acme-user" } as any);
        acmeUserId = user.id;
        await em.save(RfkNote, { body: "acme-note", user: { id: acmeUserId } } as any);
      });
      // INSERT checks the tenant of the row it writes, not the tenant of the
      // row its FK names — globex can point its rows at acme's user.
      await em.query(`INSERT INTO rfk_avatars (url, owner_id, tenant_id) VALUES ('globex.png', ?, 'globex')`, [
        acmeUserId,
      ]);
      await em.query(`INSERT INTO rfk_notes (body, user_id, tenant_id) VALUES ('globex-note', ?, 'globex')`, [
        acmeUserId,
      ]);

      await MetadataContext.run("acme", async () => {
        const user = await em.findOne(RfkUser, { where: { id: acmeUserId }, relations: RELATIONS });
        expect(shapeOf(user)).toEqual({ avatar: null, notes: ["acme-note"] });
      });
    });
  });
});
