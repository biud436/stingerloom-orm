/**
 * OneToOne 관계 통합 테스트
 *
 * @OneToOne 데코레이터를 사용한 일대일 관계의
 * 생성, 조회 (relations 옵션), 업데이트, 삭제를 검증합니다.
 *
 * 엔티티 구조:
 * - UserClass: id, name, profileFk (FK), profile (@OneToOne → ProfileClass, joinColumn)
 * - ProfileClass: id, bio
 *
 * NOTE: eager: true는 transformNested가 OneToOne을 미지원하므로 relations 옵션 사용.
 *
 * 실행 전 필요 사항:
 * - MySQL 서버 실행 중
 * - examples/nestjs-cats/.env의 연결 정보가 유효
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToOne,
} from "../../src";
import Container from "typedi";
import {
  ColumnScanner,
  OneToOneScanner,
} from "../../src/scanner";

// ─────────────────────────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────────────────────────

interface OneToOneEntitiesResult {
  UserClass: new () => any;
  ProfileClass: new () => any;
  userTableName: string;
  profileTableName: string;
}

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔티티 팩토리
// ─────────────────────────────────────────────────────────────────────────────

function createOneToOneTestEntities(): OneToOneEntitiesResult {
  const profileTableName = shortTableName("op");
  const userTableName = shortTableName("ou");

  // 스캐너 초기화
  Container.get(ColumnScanner).clear();
  Container.get(OneToOneScanner).clear();

  // ── ProfileClass ──────────────────────────────────────────────────────────
  const ProfileClass = class {} as any;
  Object.defineProperty(ProfileClass, "name", {
    value: profileTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ProfileClass.prototype, "id");
  PrimaryGeneratedColumn()(ProfileClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ProfileClass.prototype, "bio");
  Column({ type: "varchar", length: 500 })(ProfileClass.prototype, "bio");

  Entity()(ProfileClass);

  // ── UserClass ─────────────────────────────────────────────────────────────
  const UserClass = class {} as any;
  Object.defineProperty(UserClass, "name", {
    value: userTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, UserClass.prototype, "id");
  PrimaryGeneratedColumn()(UserClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, UserClass.prototype, "name");
  Column()(UserClass.prototype, "name");

  // FK 컬럼: profileFk
  Reflect.defineMetadata(
    "design:type",
    Number,
    UserClass.prototype,
    "profileFk",
  );
  Column({ type: "int", nullable: true })(UserClass.prototype, "profileFk");

  // @OneToOne(소유측): joinColumn = "profileFk"
  // eager 미사용 (transformNested가 OneToOne 미지원) → relations 옵션으로 로드
  Reflect.defineMetadata(
    "design:type",
    ProfileClass,
    UserClass.prototype,
    "profile",
  );
  OneToOne(() => ProfileClass, {
    joinColumn: "profileFk",
  })(UserClass.prototype, "profile");

  Entity()(UserClass);

  return { UserClass, ProfileClass, userTableName, profileTableName };
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] OneToOne 관계", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let entities: OneToOneEntitiesResult;
  let userRepo: BaseRepository<any>;
  let profileRepo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        entities = createOneToOneTestEntities();
        // ProfileClass(FK 대상)를 먼저 등록해야 UserClass의 FK 생성이 성공
        return {
          entities: [entities.ProfileClass, entities.UserClass],
        };
      },
    );
    em = conn.em;
    userRepo = em.getRepository(entities.UserClass);
    profileRepo = em.getRepository(entities.ProfileClass);
  }, 30000);

  afterAll(async () => {
    try {
      await rawQuery("SET FOREIGN_KEY_CHECKS = 0");
      if (entities) await dropTestTable(entities.userTableName);
      if (entities) await dropTestTable(entities.profileTableName);
      await rawQuery("SET FOREIGN_KEY_CHECKS = 1");
    } catch {
      // ignore
    }
    if (conn) await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    // FK 제약 때문에 user(자식) 먼저 삭제
    await truncateTestTable(entities.userTableName);
    await truncateTestTable(entities.profileTableName);
  });

  // ─── CREATE ─────────────────────────────────────────────────────────────────

  describe("Create - OneToOne FK 저장", () => {
    it("프로필 저장 후 유저를 FK와 함께 저장할 수 있어야 한다", async () => {
      const profile = await profileRepo.save({ bio: "Hello World" });
      expect(profile.id).toBeDefined();

      const user = await userRepo.save({
        name: "Alice",
        profileFk: profile.id,
      });
      expect(user.id).toBeDefined();
      expect(user.id).toBeGreaterThan(0);
    });

    it("FK 없이 유저를 저장할 수 있어야 한다 (nullable FK)", async () => {
      const user = await userRepo.save({
        name: "NoProfile",
        profileFk: null,
      });
      expect(user.id).toBeDefined();
    });

    it("FK 값이 DB에 정확히 저장되어야 한다", async () => {
      const profile = await profileRepo.save({ bio: "FK check" });
      await userRepo.save({ name: "FKUser", profileFk: profile.id });

      const rows = await rawQuery(
        `SELECT profileFk FROM \`${entities.userTableName}\` WHERE name = 'FKUser'`,
      );
      const rs = rows?.results ?? rows;
      const row = Array.isArray(rs) ? rs[0] : rs;
      expect(Number(row?.profileFk)).toBe(profile.id);
    });
  });

  // ─── READ: relations 옵션 ───────────────────────────────────────────────────

  describe("Read - relations 옵션으로 OneToOne 로드", () => {
    it("relations: ['profile']로 조회 시 profile 객체가 로드되어야 한다", async () => {
      const profile = await profileRepo.save({ bio: "Relations test" });
      const saved = await userRepo.save({
        name: "Bob",
        profileFk: profile.id,
      });

      const found = await userRepo.findOne({
        where: { id: saved.id },
        relations: ["profile"],
      } as any);
      const user = Array.isArray(found) ? found[0] : found;

      expect(user).toBeDefined();
      expect(user.profile).toBeDefined();
      expect(user.profile).not.toBeNull();
    });

    it("relations로 로드된 profile의 id가 일치해야 한다", async () => {
      const profile = await profileRepo.save({ bio: "ID check" });
      const saved = await userRepo.save({
        name: "Charlie",
        profileFk: profile.id,
      });

      const found = await userRepo.findOne({
        where: { id: saved.id },
        relations: ["profile"],
      } as any);
      const user = Array.isArray(found) ? found[0] : found;

      expect(user.profile.id).toBe(profile.id);
    });

    it("relations로 로드된 profile의 bio가 일치해야 한다", async () => {
      const profile = await profileRepo.save({ bio: "My bio text" });
      const saved = await userRepo.save({
        name: "Diana",
        profileFk: profile.id,
      });

      const found = await userRepo.findOne({
        where: { id: saved.id },
        relations: ["profile"],
      } as any);
      const user = Array.isArray(found) ? found[0] : found;

      expect(user.profile.bio).toBe("My bio text");
    });

    it("FK가 null인 유저의 profile은 null이어야 한다", async () => {
      const saved = await userRepo.save({
        name: "NoProfile",
        profileFk: null,
      });

      const found = await userRepo.findOne({
        where: { id: saved.id },
        relations: ["profile"],
      } as any);
      const user = Array.isArray(found) ? found[0] : found;

      expect(user.profile == null).toBe(true);
    });

    it("relations 없이 조회 시 profile이 로드되지 않아야 한다", async () => {
      const profile = await profileRepo.save({ bio: "Hidden" });
      await userRepo.save({ name: "NoRelations", profileFk: profile.id });

      const found = await userRepo.findOne({
        where: { name: "NoRelations" },
      });
      const user = Array.isArray(found) ? found[0] : found;

      const profileVal = user?.profile;
      const isEmpty =
        profileVal == null ||
        (typeof profileVal === "object" && Object.keys(profileVal).length === 0);
      expect(isEmpty).toBe(true);
    });
  });

  // ─── UPDATE ─────────────────────────────────────────────────────────────────

  describe("Update - FK 변경", () => {
    it("유저의 FK를 다른 프로필로 변경할 수 있어야 한다", async () => {
      const p1 = await profileRepo.save({ bio: "Original Profile" });
      const p2 = await profileRepo.save({ bio: "New Profile" });

      const user = await userRepo.save({
        name: "Eve",
        profileFk: p1.id,
      });

      // FK 변경
      await userRepo.save({
        id: user.id,
        name: "Eve",
        profileFk: p2.id,
      });

      // relations 옵션으로 재조회
      const found = await userRepo.findOne({
        where: { id: user.id },
        relations: ["profile"],
      } as any);
      const updated = Array.isArray(found) ? found[0] : found;

      expect(updated.profile).toBeDefined();
      expect(updated.profile.id).toBe(p2.id);
      expect(updated.profile.bio).toBe("New Profile");
    });

    it("프로필 bio를 변경하면 유저의 relations 로드 결과에 반영되어야 한다", async () => {
      const profile = await profileRepo.save({ bio: "Old Bio" });
      const user = await userRepo.save({
        name: "Frank",
        profileFk: profile.id,
      });

      // 프로필 업데이트
      await profileRepo.save({ id: profile.id, bio: "New Bio" });

      const found = await userRepo.findOne({
        where: { id: user.id },
        relations: ["profile"],
      } as any);
      const u = Array.isArray(found) ? found[0] : found;

      expect(u.profile.bio).toBe("New Bio");
    });
  });

  // ─── DELETE ─────────────────────────────────────────────────────────────────

  describe("Delete - 참조 무결성", () => {
    it("유저만 삭제해도 프로필은 유지되어야 한다", async () => {
      const profile = await profileRepo.save({ bio: "Surviving" });
      const user = await userRepo.save({
        name: "ToDelete",
        profileFk: profile.id,
      });

      await userRepo.delete({ id: user.id } as any);

      // 유저 삭제 확인
      const foundUser = await userRepo.findOne({ where: { id: user.id } });
      if (Array.isArray(foundUser)) {
        expect(foundUser.length).toBe(0);
      } else {
        expect(foundUser).toBeNull();
      }

      // 프로필은 유지
      const foundProfile = await profileRepo.findOne({
        where: { id: profile.id },
      });
      const p = Array.isArray(foundProfile) ? foundProfile[0] : foundProfile;
      expect(p).toBeDefined();
      expect(p.bio).toBe("Surviving");
    });
  });

  // ─── Full Lifecycle ───────────────────────────────────────────────────────

  describe("전체 OneToOne 라이프사이클", () => {
    it("Profile 생성 → User 생성(FK) → 조회(relations) → FK 변경 → 삭제", async () => {
      // 1. Profile 생성
      const profile1 = await profileRepo.save({ bio: "LC Profile 1" });
      const profile2 = await profileRepo.save({ bio: "LC Profile 2" });

      // 2. User 생성 (FK=profile1)
      const user = await userRepo.save({
        name: "LC User",
        profileFk: profile1.id,
      });
      expect(user.id).toBeGreaterThan(0);

      // 3. relations 옵션으로 조회 확인
      let found = await userRepo.findOne({
        where: { id: user.id },
        relations: ["profile"],
      } as any);
      let u = Array.isArray(found) ? found[0] : found;
      expect(u.profile.id).toBe(profile1.id);
      expect(u.profile.bio).toBe("LC Profile 1");

      // 4. FK 변경 → profile2
      await userRepo.save({
        id: user.id,
        name: "LC User",
        profileFk: profile2.id,
      });

      found = await userRepo.findOne({
        where: { id: user.id },
        relations: ["profile"],
      } as any);
      u = Array.isArray(found) ? found[0] : found;
      expect(u.profile.id).toBe(profile2.id);
      expect(u.profile.bio).toBe("LC Profile 2");

      // 5. User 삭제
      const deleteResult = await userRepo.delete({ id: user.id } as any);
      expect(deleteResult.affected).toBe(1);

      // 6. Profile 유지 확인
      const p1 = await profileRepo.findOne({
        where: { id: profile1.id },
      });
      expect(Array.isArray(p1) ? p1[0] : p1).toBeDefined();
    });
  });
});
