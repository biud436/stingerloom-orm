import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { ReadExecutor } from "../../src/core/entity-manager/ReadExecutor";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

// ── Test Entity ───────────────────────────────────────────

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

// ── Mock helpers ──────────────────────────────────────────

function createMockEmWithData(
  rows: any[],
  dbType: "mysql" | "postgresql" = "mysql",
) {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
    return `"${col.replace(/"/g, '""')}"`;
  }
  return {
    wrap,
    wrapTable: wrap,
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
    },
    async query<T>(): Promise<T[]> {
      return rows as T[];
    },
  } as unknown as EntityManager;
}

// ── Tests ─────────────────────────────────────────────────

describe("findOneOrFail / getOneOrFail", () => {
  describe("EntityManager.findOneOrFail()", () => {
    it("should return entity when found", async () => {
      const mockEm = {
        findOne: jest.fn().mockResolvedValue({ id: 1, name: "Alice" }),
        findOneOrFail: EntityManager.prototype.findOneOrFail,
      };

      const result = await mockEm.findOneOrFail(User, {
        where: { id: 1 } as any,
      });

      expect(result).toEqual({ id: 1, name: "Alice" });
      expect(mockEm.findOne).toHaveBeenCalledWith(User, {
        where: { id: 1 },
      });
    });

    it("should throw EntityNotFoundError when not found", async () => {
      const mockEm = {
        findOne: jest.fn().mockResolvedValue(null),
        findOneOrFail: EntityManager.prototype.findOneOrFail,
      };

      await expect(
        mockEm.findOneOrFail(User, { where: { id: 999 } as any }),
      ).rejects.toThrow(EntityNotFoundError);

      await expect(
        mockEm.findOneOrFail(User, { where: { id: 999 } as any }),
      ).rejects.toThrow('Entity "User" not found.');
    });

    it("should throw EntityNotFoundError when findOne returns undefined", async () => {
      const mockEm = {
        findOne: jest.fn().mockResolvedValue(undefined),
        findOneOrFail: EntityManager.prototype.findOneOrFail,
      };

      await expect(
        mockEm.findOneOrFail(User, { where: { id: 999 } as any }),
      ).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("all-undefined where", () => {
    /**
     * `findOneOrFail({ where: { id: maybeId } })` with `maybeId` undefined used
     * to drop the only condition, read `SELECT ... LIMIT 1` and return an
     * arbitrary row — the "or fail" never fired, so the caller went on with the
     * wrong entity. The guard sits on the public `ReadExecutor.findOne`, not on
     * `findOneInternal`, so save()'s readbacks keep their old behavior.
     */
    it("rejects in ReadExecutor.findOne before findOneInternal runs", async () => {
      const ctx = {
        findOneInternal: jest.fn().mockResolvedValue({ id: 1, name: "Alice" }),
      };
      const executor = {
        ctx,
        findOne: ReadExecutor.prototype.findOne,
      } as unknown as ReadExecutor;

      await expect(
        executor.findOne(User, { where: { id: undefined } as any }),
      ).rejects.toThrow(InvalidQueryError);
      await expect(
        executor.findOne(User, { where: { id: undefined } as any }),
      ).rejects.toThrow(
        'Every value in the "where" passed to findOne() for entity "User" is undefined (id)',
      );
      expect(ctx.findOneInternal).not.toHaveBeenCalled();
    });

    it("still reads when one value is defined, and when no field is named", async () => {
      const ctx = {
        findOneInternal: jest.fn().mockResolvedValue({ id: 2, name: "Bob" }),
      };
      const executor = {
        ctx,
        findOne: ReadExecutor.prototype.findOne,
      } as unknown as ReadExecutor;

      await expect(
        executor.findOne(User, { where: { id: undefined, name: "Bob" } as any }),
      ).resolves.toEqual({ id: 2, name: "Bob" });
      await expect(executor.findOne(User, {})).resolves.toEqual({
        id: 2,
        name: "Bob",
      });
      expect(ctx.findOneInternal).toHaveBeenCalledTimes(2);
    });

    it("findOneOrFail surfaces the InvalidQueryError instead of an arbitrary row", async () => {
      // The guard has to run inside the real findOne for this to mean
      // anything: before the fix, findOne resolved the row findOneInternal
      // handed back and findOneOrFail returned that stranger.
      const ctx = {
        findOneInternal: jest
          .fn()
          .mockResolvedValue({ id: 7, name: "Arbitrary" }),
      };
      const executor = {
        ctx,
        findOne: ReadExecutor.prototype.findOne,
      } as unknown as ReadExecutor;
      const mockEm = {
        findOne: (entity: any, findOption: any) =>
          executor.findOne(entity, findOption),
        findOneOrFail: EntityManager.prototype.findOneOrFail,
      };

      await expect(
        mockEm.findOneOrFail(User, { where: { id: undefined } as any }),
      ).rejects.toThrow(InvalidQueryError);
      await expect(
        mockEm.findOneOrFail(User, { where: { id: undefined } as any }),
      ).rejects.not.toThrow(EntityNotFoundError);
      expect(ctx.findOneInternal).not.toHaveBeenCalled();
    });
  });

  describe("BaseRepository.findOneOrFail()", () => {
    it("should delegate to EntityManager.findOneOrFail", async () => {
      const mockEm = {
        findOneOrFail: jest.fn().mockResolvedValue({ id: 1, name: "Alice" }),
      } as any;

      const repo = new BaseRepository(User, mockEm);
      const result = await repo.findOneOrFail({ where: { id: 1 } as any });

      expect(result).toEqual({ id: 1, name: "Alice" });
      expect(mockEm.findOneOrFail).toHaveBeenCalledWith(User, {
        where: { id: 1 },
      });
    });

    it("should propagate EntityNotFoundError from EntityManager", async () => {
      const mockEm = {
        findOneOrFail: jest
          .fn()
          .mockRejectedValue(new EntityNotFoundError("User")),
      } as any;

      const repo = new BaseRepository(User, mockEm);

      await expect(
        repo.findOneOrFail({ where: { id: 999 } as any }),
      ).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe("SelectQueryBuilder.getOneOrFail()", () => {
    it("should return entity when result exists", async () => {
      const em = createMockEmWithData([
        { id: 1, name: "Alice", email: "a@test.com" },
      ]);
      const qb = new SelectQueryBuilder(User, "u", em);
      const result = await qb.getOneOrFail();

      expect(result).toBeInstanceOf(User);
      expect(result.id).toBe(1);
      expect(result.name).toBe("Alice");
    });

    it("should throw EntityNotFoundError when no result", async () => {
      const em = createMockEmWithData([]);
      const qb = new SelectQueryBuilder(User, "u", em);

      await expect(qb.getOneOrFail()).rejects.toThrow(EntityNotFoundError);
      await expect(qb.getOneOrFail()).rejects.toThrow(
        'Entity "User" not found.',
      );
    });
  });
});
