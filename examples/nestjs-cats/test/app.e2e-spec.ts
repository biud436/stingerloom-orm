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
        .send({ cats })
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
        // The IDs on the second page must be greater than those on the first
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

  // ─── Buffer Plugin ────────────────────────────────

  describe("Buffer Plugin", () => {
    let bufCatIds: number[];

    beforeAll(async () => {
      bufCatIds = [];
      for (const c of [
        { name: "Luna", age: 2, breed: "Persian" },
        { name: "Milo", age: 3, breed: "Persian" },
        { name: "Nabi", age: 1, breed: "Bengal" },
      ]) {
        const res = await request(server).post("/cats").send(c).expect(201);
        bufCatIds.push(res.body.id);
        await wait();
      }
    });

    afterAll(async () => {
      for (const id of bufCatIds) {
        await request(server).delete(`/cats/${id}`);
      }
    });

    it("PATCH /cats/buffer/rename — batch rename via dirty checking", async () => {
      const res = await request(server)
        .patch("/cats/buffer/rename")
        .send({
          updates: [
            { id: bufCatIds[0], name: "Luna★" },
            { id: bufCatIds[1], name: "Milo★" },
          ],
        })
        .expect(200);

      expect(res.body.updates).toBe(2);
      expect(res.body.inserts).toBe(0);
      expect(res.body.deletes).toBe(0);

      // Verify
      const cat0 = await request(server).get(`/cats/${bufCatIds[0]}`).expect(200);
      expect(cat0.body.name).toBe("Luna★");
      const cat1 = await request(server).get(`/cats/${bufCatIds[1]}`).expect(200);
      expect(cat1.body.name).toBe("Milo★");
    });

    it("PATCH /cats/buffer/rename — no-op when name unchanged", async () => {
      const res = await request(server)
        .patch("/cats/buffer/rename")
        .send({ updates: [{ id: bufCatIds[0], name: "Luna★" }] })
        .expect(200);

      expect(res.body.updates).toBe(0);
    });

    it("PATCH /cats/buffer/rename — 404 for non-existent cat", async () => {
      await request(server)
        .patch("/cats/buffer/rename")
        .send({ updates: [{ id: 999999, name: "Ghost" }] })
        .expect(404);
    });

    it("POST /cats/buffer/mixed-flush — create + update + delete atomically", async () => {
      const res = await request(server)
        .post("/cats/buffer/mixed-flush")
        .send({
          create: [{ name: "NewCat", age: 1, breed: "Sphynx" }],
          update: [{ id: bufCatIds[0], name: "Luna-Mixed" }],
          deleteIds: [bufCatIds[2]],
        })
        .expect(201);

      expect(res.body.inserts).toBe(1);
      expect(res.body.updates).toBe(1);
      expect(res.body.deletes).toBe(1);

      // Verify update
      const updated = await request(server).get(`/cats/${bufCatIds[0]}`).expect(200);
      expect(updated.body.name).toBe("Luna-Mixed");

      // Verify delete
      await request(server).get(`/cats/${bufCatIds[2]}`).expect(404);

      // Track new cat for cleanup
      const allCats = await request(server).get("/cats").expect(200);
      const newCat = allCats.body.find((c: any) => c.name === "NewCat");
      if (newCat) bufCatIds.push(newCat.id);
    });

    it("POST /cats/buffer/birthday — increment age for a breed", async () => {
      const before0 = await request(server).get(`/cats/${bufCatIds[0]}`).expect(200);
      const before1 = await request(server).get(`/cats/${bufCatIds[1]}`).expect(200);

      const res = await request(server)
        .post("/cats/buffer/birthday")
        .send({ breed: "Persian" })
        .expect(201);

      expect(res.body.updates).toBeGreaterThanOrEqual(2);

      const after0 = await request(server).get(`/cats/${bufCatIds[0]}`).expect(200);
      const after1 = await request(server).get(`/cats/${bufCatIds[1]}`).expect(200);
      expect(after0.body.age).toBe(before0.body.age + 1);
      expect(after1.body.age).toBe(before1.body.age + 1);
    });

    it("POST /cats/buffer/birthday — no-op for non-existent breed", async () => {
      const res = await request(server)
        .post("/cats/buffer/birthday")
        .send({ breed: "Unicorn" })
        .expect(201);

      expect(res.body.updates).toBe(0);
      expect(res.body.inserts).toBe(0);
    });

    it("POST /cats/buffer/preview-breed-rename — dry-run without DB write", async () => {
      const res = await request(server)
        .post("/cats/buffer/preview-breed-rename")
        .send({ from: "Persian", to: "Persian Longhair" })
        .expect(201);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      expect(res.body[0].action).toBe("update");
      expect(res.body[0].data.breed).toBe("Persian Longhair");

      // Verify DB unchanged
      const cat = await request(server).get(`/cats/${bufCatIds[0]}`).expect(200);
      expect(cat.body.breed).toBe("Persian");
    });

    it("GET /cats/buffer/identity-map/:id — same reference", async () => {
      const res = await request(server)
        .get(`/cats/buffer/identity-map/${bufCatIds[0]}`)
        .expect(200);

      expect(res.body.same).toBe(true);
    });

    it("GET /cats/buffer/entity-state/:id — MANAGED → REMOVED", async () => {
      const res = await request(server)
        .get(`/cats/buffer/entity-state/${bufCatIds[0]}`)
        .expect(200);

      expect(res.body.afterLoad).toBe("MANAGED");
      expect(res.body.afterRemove).toBe("REMOVED");
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
      // Get the list of remaining cat IDs (everything except catId)
      const listRes = await request(server).get("/cats").expect(200);
      const bulkIds = listRes.body
        .filter((c: any) => c.id !== catId)
        .map((c: any) => c.id);

      if (bulkIds.length > 0) {
        const deleteRes = await request(server)
          .delete("/cats/bulk")
          .send({ ids: bulkIds });
        expect(deleteRes.status).toBe(200);
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
