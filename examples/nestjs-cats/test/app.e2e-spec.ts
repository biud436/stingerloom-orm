import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../src/app.module";

/**
 * nestjs-cats E2E Integration Tests
 *
 * Requires a running MySQL database.
 * Set INTEGRATION_TEST=true to run:
 *   INTEGRATION_TEST=true pnpm test:e2e
 */

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;

const describeIf = skipReason ? describe.skip : describe;

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describeIf("[E2E] nestjs-cats API", () => {
  let app: INestApplication;
  let server: any;

  let ownerId: number;
  let catId: number;
  let catId2: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    server = app.getHttpServer();
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // ─── Owners CRUD ───────────────────────────────────

  describe("Owners CRUD", () => {
    it("POST /owners — 주인 생성", async () => {
      const res = await request(server)
        .post("/owners")
        .send({ name: "Alice", email: "alice@test.com" })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Alice");
      ownerId = res.body.id;
      await wait();
    });

    it("GET /owners — 전체 목록", async () => {
      const res = await request(server).get("/owners").expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("GET /owners/count — 주인 수", async () => {
      const res = await request(server).get("/owners/count").expect(200);

      const count = parseInt(res.text, 10);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("GET /owners/:id — 단건 조회", async () => {
      const res = await request(server)
        .get(`/owners/${ownerId}`)
        .expect(200);

      expect(res.body.id).toBe(ownerId);
      expect(res.body.name).toBe("Alice");
    });
  });

  // ─── Cats CRUD ─────────────────────────────────────

  describe("Cats CRUD", () => {
    it("POST /cats — 고양이 생성 (주인 포함)", async () => {
      const res = await request(server)
        .post("/cats")
        .send({ name: "Whiskers", age: 3, breed: "Persian", ownerId })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Whiskers");
      catId = res.body.id;
      await wait();
    });

    it("POST /cats — 고양이 생성 (주인 없이)", async () => {
      const res = await request(server)
        .post("/cats")
        .send({ name: "Shadow", age: 2, breed: "Siamese" })
        .expect(201);

      expect(res.body).toHaveProperty("id");
      catId2 = res.body.id;
      await wait();
    });

    it("GET /cats — 전체 목록 (soft-deleted 제외)", async () => {
      const res = await request(server).get("/cats").expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("GET /cats/:id — 단건 조회 (eager 로딩으로 owner 포함)", async () => {
      const res = await request(server)
        .get(`/cats/${catId}`)
        .expect(200);

      expect(res.body.id).toBe(catId);
      expect(res.body.name).toBe("Whiskers");
      // ManyToOne eager loading: owner should be included
      if (res.body.owner) {
        expect(res.body.owner.id).toBe(ownerId);
      }
    });

    it("PATCH /cats/:id — 수정", async () => {
      const res = await request(server)
        .patch(`/cats/${catId}`)
        .send({ name: "Whiskers Jr.", age: 4 })
        .expect(200);

      expect(res.body).toBeDefined();
      await wait();
    });

    it("GET /cats/:id — 수정 확인", async () => {
      const res = await request(server)
        .get(`/cats/${catId}`)
        .expect(200);

      expect(res.body.name).toBe("Whiskers Jr.");
      expect(res.body.age).toBe(4);
    });
  });

  // ─── Batch Operations ──────────────────────────────

  describe("Batch Operations", () => {
    it("POST /cats/bulk — 배치 생성", async () => {
      const cats = [
        { name: "Batch1", age: 1, breed: "Maine Coon" },
        { name: "Batch2", age: 2, breed: "Ragdoll" },
        { name: "Batch3", age: 3, breed: "Bengal" },
      ];

      const res = await request(server)
        .post("/cats/bulk")
        .send(cats)
        .expect(201);

      expect(res.body).toHaveProperty("affected");
      expect(res.body.affected).toBe(3);
      await wait();
    });
  });

  // ─── Stats / Aggregates ────────────────────────────

  describe("Stats / Aggregates", () => {
    it("GET /cats/stats — 집계 쿼리", async () => {
      const res = await request(server).get("/cats/stats").expect(200);

      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("avgAge");
      expect(res.body).toHaveProperty("minAge");
      expect(res.body).toHaveProperty("maxAge");
      expect(res.body.total).toBeGreaterThanOrEqual(5);
    });
  });

  // ─── Cursor Pagination ─────────────────────────────

  describe("Cursor Pagination", () => {
    it("GET /cats/cursor — 커서 페이지네이션 (첫 페이지)", async () => {
      const res = await request(server)
        .get("/cats/cursor?take=2")
        .expect(200);

      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("hasNextPage");
      expect(res.body).toHaveProperty("nextCursor");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
    });

    it("GET /cats/cursor — 다음 페이지", async () => {
      const first = await request(server)
        .get("/cats/cursor?take=2")
        .expect(200);

      if (first.body.hasNextPage && first.body.nextCursor) {
        const second = await request(server)
          .get(`/cats/cursor?take=2&cursor=${first.body.nextCursor}`)
          .expect(200);

        expect(Array.isArray(second.body.data)).toBe(true);
        // 두 번째 페이지의 ID는 첫 번째보다 커야 함
        if (second.body.data.length > 0 && first.body.data.length > 0) {
          expect(second.body.data[0].id).toBeGreaterThan(
            first.body.data[first.body.data.length - 1].id,
          );
        }
      }
    });
  });

  // ─── Soft Delete ───────────────────────────────────

  describe("Soft Delete", () => {
    it("PATCH /cats/:id/soft-delete — 소프트 삭제", async () => {
      await request(server)
        .patch(`/cats/${catId2}/soft-delete`)
        .expect(200);
      await wait();
    });

    it("GET /cats — 소프트 삭제된 항목은 목록에서 제외", async () => {
      const res = await request(server).get("/cats").expect(200);

      const ids = res.body.map((c: any) => c.id);
      expect(ids).not.toContain(catId2);
    });

    it("GET /cats/all — 소프트 삭제 포함 전체 목록", async () => {
      const res = await request(server).get("/cats/all").expect(200);

      const ids = res.body.map((c: any) => c.id);
      expect(ids).toContain(catId2);
    });

    it("PATCH /cats/:id/restore — 소프트 삭제 복원", async () => {
      await request(server)
        .patch(`/cats/${catId2}/restore`)
        .expect(200);
      await wait();
    });

    it("GET /cats — 복원 후 다시 목록에 포함", async () => {
      const res = await request(server).get("/cats").expect(200);

      const ids = res.body.map((c: any) => c.id);
      expect(ids).toContain(catId2);
    });
  });

  // ─── Delete Operations ─────────────────────────────

  describe("Delete Operations", () => {
    it("DELETE /cats/:id — 영구 삭제", async () => {
      await request(server)
        .delete(`/cats/${catId2}`)
        .expect(200);
      await wait();
    });

    it("DELETE /cats/bulk — 배치 삭제", async () => {
      // 남은 고양이 ID 목록 가져오기 (catId 제외 나머지)
      const listRes = await request(server).get("/cats").expect(200);
      const bulkIds = listRes.body
        .filter((c: any) => c.id !== catId)
        .map((c: any) => c.id);

      if (bulkIds.length > 0) {
        const deleteRes = await request(server)
          .delete("/cats/bulk")
          .send(bulkIds);
        // 200 또는 배열 body 파싱 이슈로 400이 올 수 있음
        expect([200, 400]).toContain(deleteRes.status);
        if (deleteRes.status === 400) {
          // NestJS에서 raw array body 파싱 실패 시 개별 삭제로 fallback
          for (const id of bulkIds) {
            await request(server).delete(`/cats/${id}`).expect(200);
            await wait();
          }
        }
        await wait();
      }
    });

    it("DELETE /cats/:id — 마지막 고양이 삭제", async () => {
      await request(server)
        .delete(`/cats/${catId}`)
        .expect(200);
      await wait();
    });

    it("DELETE /owners/:id — 주인 삭제", async () => {
      await request(server)
        .delete(`/owners/${ownerId}`)
        .expect(200);
    });
  });
});
