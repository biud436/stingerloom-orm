/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column strategy — lazy 관계 로딩은 "하이드레이션 시점" 테넌트로
 * 실행되어야 한다 (SQLite :memory:).
 *
 * lazy 프록시의 loadFn은 프로퍼티 접근 시점에 실행된다. 종전에는 접근
 * 시점의 MetadataContext를 그대로 사용해서:
 *
 *   - tenant_column: 다른 테넌트 컨텍스트에서 접근하면 소유 테넌트의
 *     관계 행이 필터에 걸려 null (조용한 데이터 소실)
 *   - schema_qualified: 접근 시점 테넌트의 스키마로 테이블이 해석되어
 *     같은 id의 "다른 테넌트 행"이 하이드레이션될 수 있음 (오염)
 *
 * 계약: 엔티티를 하이드레이션한 시점의 컨텍스트(테넌트 + unscoped)를
 * 캡처해 lazy 로드에서 재생한다 — eager 로딩(하이드레이션 시점에 관계를
 * 함께 읽음)과 대칭인 object-graph 일관성.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";

async function makeEm(entities: any[]) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities,
      synchronize: true,
      tenantStrategy: "tenant_column",
      logging: false,
    },
    `tclz_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

describe("[Integration] SQLite: tenant_column — lazy 로딩의 컨텍스트 캡처", () => {
  beforeEach(() => MetadataContext.reset());

  @Entity()
  class ProfileLZ {
    @PrimaryGeneratedColumn() id!: number;
    @Column() bio!: string;
    @OneToMany(() => MemberLZ, { mappedBy: "profile" }) members!: MemberLZ[];
  }

  @Entity()
  class MemberLZ {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
    @Column({ type: "int", nullable: true }) profileId!: number | null;
    @ManyToOne(() => ProfileLZ, (p: any) => p.members, {
      joinColumn: "profileId",
      lazy: true,
      createForeignKeyConstraints: false,
    })
    profile!: ProfileLZ | null;
  }

  async function seedAcme(em: EntityManager): Promise<any> {
    return MetadataContext.run("acme", async () => {
      const p: any = await em.save(ProfileLZ, { bio: "acme-bio" });
      await em.save(MemberLZ, { name: "acme-member", profileId: p.id });
      return em.findOne(MemberLZ, { where: { name: "acme-member" } as any });
    });
  }

  it("다른 테넌트 컨텍스트에서 접근해도 소유 테넌트의 관계가 로드된다", async () => {
    const em = await makeEm([ProfileLZ, MemberLZ]);
    try {
      const member: any = await seedAcme(em);
      expect(member).not.toBeNull();

      // 접근은 globex 컨텍스트에서 — 하이드레이션 시점(acme)이 이겨야 한다.
      const profile: any = await MetadataContext.run("globex", async () => {
        return member.profile;
      });
      expect(profile?.bio).toBe("acme-bio");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("컨텍스트가 끝난 뒤 접근해도 소유 테넌트로 로드된다 (경고 없이)", async () => {
    const em = await makeEm([ProfileLZ, MemberLZ]);
    try {
      const member: any = await seedAcme(em);

      // MetadataContext.run 밖 — 캡처된 acme 컨텍스트가 재생되어야 한다.
      const profile: any = await member.profile;
      expect(profile?.bio).toBe("acme-bio");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("같은 테넌트 컨텍스트 안에서의 접근은 그대로 동작한다 (sanity)", async () => {
    const em = await makeEm([ProfileLZ, MemberLZ]);
    try {
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(ProfileLZ, { bio: "acme-bio" });
        await em.save(MemberLZ, { name: "m1", profileId: p.id });
        const member: any = await em.findOne(MemberLZ, {
          where: { name: "m1" } as any,
        });
        const profile: any = await member.profile;
        expect(profile?.bio).toBe("acme-bio");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });
});
