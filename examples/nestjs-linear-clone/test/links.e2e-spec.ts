import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
} from "./helpers/test-app";
import {
  createBaseFixture,
  createIssue,
  BaseFixture,
} from "./helpers/fixtures";

integrationDescribe("[E2E] Issue Links — typed graph + cycle detection", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;

  let aId: number;
  let bId: number;
  let cId: number;
  let dId: number;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);

    const a = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Link A",
    });
    const b = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Link B",
    });
    const c = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Link C",
    });
    const d = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Link D",
    });
    aId = a.id;
    bId = b.id;
    cId = c.id;
    dId = d.id;
  }, 60000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  describe("Cycle-free chain", () => {
    it("creates A → B (blocks)", async () => {
      const r = await api
        .post(`/issues/${aId}/links`)
        .send({ targetId: bId, type: "blocks" })
        .expect(201);
      expect(r.body.id).toBeDefined();
      expect(r.body.type).toBe("blocks");
    });

    it("creates B → C (blocks)", async () => {
      const r = await api
        .post(`/issues/${bId}/links`)
        .send({ targetId: cId, type: "blocks" })
        .expect(201);
      expect(r.body.id).toBeDefined();
    });
  });

  describe("Self-loop and cycle rejection", () => {
    it("rejects self-loop A → A with 422 CYCLE_DETECTED", async () => {
      const r = await api
        .post(`/issues/${aId}/links`)
        .send({ targetId: aId, type: "blocks" })
        .expect(422);
      expect(r.body.code).toBe("CYCLE_DETECTED");
    });

    it("rejects C → A because A → B → C already exists (closes the cycle)", async () => {
      const r = await api
        .post(`/issues/${cId}/links`)
        .send({ targetId: aId, type: "blocks" })
        .expect(422);
      expect(r.body.code).toBe("CYCLE_DETECTED");
    });

    it("rejects duplicate A → B via the unique index", async () => {
      const r = await api
        .post(`/issues/${aId}/links`)
        .send({ targetId: bId, type: "blocks" });
      // 409 from UNIQUE_VIOLATION mapper, or 422 if surfaced as CONSTRAINT
      expect([409, 422]).toContain(r.status);
    });
  });

  describe("Transitive closures", () => {
    it("A.dependents = [B(depth=1), C(depth=2)] in BFS order", async () => {
      const r = await api.get(`/issues/${aId}/dependents`).expect(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(2);
      expect(r.body[0].id).toBe(bId);
      expect(r.body[0].depth).toBe(1);
      expect(r.body[1].id).toBe(cId);
      expect(r.body[1].depth).toBe(2);
    });

    it("C.blockers = [B(depth=1), A(depth=2)] in BFS order", async () => {
      const r = await api.get(`/issues/${cId}/blockers`).expect(200);
      expect(r.body.length).toBe(2);
      expect(r.body[0].id).toBe(bId);
      expect(r.body[0].depth).toBe(1);
      expect(r.body[1].id).toBe(aId);
      expect(r.body[1].depth).toBe(2);
    });

    it("D has no dependents and no blockers (isolated node)", async () => {
      const dep = await api.get(`/issues/${dId}/dependents`).expect(200);
      const blk = await api.get(`/issues/${dId}/blockers`).expect(200);
      expect(dep.body).toEqual([]);
      expect(blk.body).toEqual([]);
    });
  });

  describe("blockedBy is canonicalized to inverse blocks", () => {
    it("D blockedBy A inserts a blocks edge A → D, so A.dependents now contains D", async () => {
      await api
        .post(`/issues/${dId}/links`)
        .send({ targetId: aId, type: "blockedBy" })
        .expect(201);

      const dep = await api.get(`/issues/${aId}/dependents`).expect(200);
      const ids = dep.body.map((row: { id: number }) => row.id);
      expect(ids).toContain(dId);
    });
  });

  describe("DELETE removes a link", () => {
    let linkId: number;

    it("creates a relatesTo link to delete", async () => {
      const r = await api
        .post(`/issues/${aId}/links`)
        .send({ targetId: dId, type: "relatesTo" })
        .expect(201);
      linkId = r.body.id;
    });

    it("DELETE returns 204", async () => {
      await api.delete(`/issues/${aId}/links/${linkId}`).expect(204);
    });

    it("DELETE on a missing link returns 404", async () => {
      await api.delete(`/issues/${aId}/links/${linkId}`).expect(404);
    });
  });
});
