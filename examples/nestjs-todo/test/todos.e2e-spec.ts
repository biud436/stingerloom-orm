import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Todos (e2e) - @stingerloom/orm verification", () => {
  let app: INestApplication;
  let createdId: number;
  let batchIds: number[];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /todos - create a todo", async () => {
    const res = await request(app.getHttpServer())
      .post("/todos")
      .send({ title: "Buy milk", description: "From the store" })
      .expect(201);

    expect(res.body).toHaveProperty("id");
    expect(res.body.title).toBe("Buy milk");
    // MySQL TINYINT returns 0/1 instead of true/false
    expect(res.body.completed).toBeFalsy();
    createdId = res.body.id;
  });

  it("GET /todos - list all todos", async () => {
    const res = await request(app.getHttpServer())
      .get("/todos")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /todos/:id - get single todo", async () => {
    const res = await request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(200);

    expect(res.body.id).toBe(createdId);
    expect(res.body.title).toBe("Buy milk");
  });

  it("PATCH /todos/:id - update a todo", async () => {
    await request(app.getHttpServer())
      .patch(`/todos/${createdId}`)
      .send({ completed: true, title: "Buy milk (done)" })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(200);

    expect(res.body.title).toBe("Buy milk (done)");
    expect(res.body.completed).toBeTruthy();
  });

  it("DELETE /todos/:id - soft delete a todo", async () => {
    await request(app.getHttpServer())
      .delete(`/todos/${createdId}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(404);
  });

  it("GET /todos/:id - 404 for non-existent", async () => {
    await request(app.getHttpServer())
      .get("/todos/999999")
      .expect(404);
  });

  // ── Mutation Plugin: batch complete ───────────────────────

  it("PATCH /todos/batch/complete - batch complete multiple todos", async () => {
    // Create 3 todos
    const ids: number[] = [];
    for (const title of ["Task A", "Task B", "Task C"]) {
      const res = await request(app.getHttpServer())
        .post("/todos")
        .send({ title })
        .expect(201);
      ids.push(res.body.id);
    }
    batchIds = ids;

    // Batch complete
    const res = await request(app.getHttpServer())
      .patch("/todos/batch/complete")
      .send({ ids })
      .expect(200);

    expect(res.body.updates).toBe(3);
    expect(res.body.inserts).toBe(0);
    expect(res.body.deletes).toBe(0);
  });

  it("PATCH /todos/batch/complete - verify todos are completed", async () => {
    for (const id of batchIds) {
      const res = await request(app.getHttpServer())
        .get(`/todos/${id}`)
        .expect(200);

      expect(res.body.completed).toBeTruthy();
    }
  });

  it("PATCH /todos/batch/complete - 404 for non-existent id", async () => {
    await request(app.getHttpServer())
      .patch("/todos/batch/complete")
      .send({ ids: [999999] })
      .expect(404);
  });
});
