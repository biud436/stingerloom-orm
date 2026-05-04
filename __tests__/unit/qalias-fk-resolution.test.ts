import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  RelationColumn,
} from "../../src/decorators";
import { OneToOne } from "../../src/decorators/OneToOne";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

@Entity()
class Workspace {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

@Entity()
class UserProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  bio!: string;
}

@Entity()
class Member {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Workspace, (w: Workspace) => w.id)
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  // Bare backing property — no @Column decorator. The fix must let
  // qAlias(Member).workspaceId resolve to the FK column "workspace_id".
  workspaceId?: number;

  @OneToOne(() => UserProfile, { joinColumn: "profile_id" })
  profile!: UserProfile;

  profileId?: number;

  @Column({ type: "varchar", length: 16 })
  role!: string;
}

type DbType = "mysql" | "postgresql" | "sqlite";

function createMockEm(dbType: DbType = "postgresql"): EntityManager {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
    return `"${col.replace(/"/g, '""')}"`;
  }
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => dbType === "sqlite",
      getDialect: () =>
        dbType === "mysql" ? "mysql" : dbType === "sqlite" ? "sqlite" : "postgresql",
    },
  } as unknown as EntityManager;
}

function createQb(dbType: DbType = "postgresql") {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<Member>(Member, "m", em);
  // Mirror the production path: SelectQueryBuilder receives the property
  // map built by EntityManager.buildPropertyToColumnMap, which now folds
  // FK backing-property mappings in via collectFkPropertyMappings().
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Member);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      map.set((c as any).propertyKey ?? c.name!, c.name!);
    }
    const fk = resolver.collectFkPropertyMappings(Member);
    for (const [prop, col] of fk) {
      if (!map.has(prop)) map.set(prop, col);
    }
    qb.setPropertyToColumnMap(map);
  }
  const dialectName = dbType === "postgresql" ? "postgres" : dbType;
  qb.setDialectExpression(createDialectExpression(dialectName));
  return qb;
}

describe("qAlias FK property resolution", () => {
  it("resolves @ManyToOne + @RelationColumn FK property to snake_case column", () => {
    const m = qAlias(Member, "m");
    const qb = createQb("postgresql");

    const built = qb.where(m.workspaceId.eq(42)).toSql();
    expect(built.text).toMatch(/"m"\."workspace_id" = \$\d+/);
    expect(built.values).toContain(42);
  });

  it("resolves @OneToOne FK property to the joinColumn", () => {
    const m = qAlias(Member, "m");
    const qb = createQb("postgresql");

    const built = qb.where(m.profileId.eq(7)).toSql();
    expect(built.text).toMatch(/"m"\."profile_id" = \$\d+/);
  });

  it("does not shadow explicit @Column property mappings", () => {
    const m = qAlias(Member, "m");
    const qb = createQb("postgresql");

    const built = qb.where(m.role.eq("admin")).toSql();
    expect(built.text).toMatch(/"m"\."role" = \$\d+/);
  });

  it("RelationMetadataResolver.collectFkPropertyMappings exposes the mappings", () => {
    const resolver = new RelationMetadataResolver();
    const map = resolver.collectFkPropertyMappings(Member);

    expect(map.get("workspaceId")).toBe("workspace_id");
    expect(map.get("profileId")).toBe("profile_id");
  });
});
