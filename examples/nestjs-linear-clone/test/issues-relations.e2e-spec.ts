import * as request from "supertest";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  BootedApp,
} from "./helpers/test-app";
import { createBaseFixture, createIssue, BaseFixture } from "./helpers/fixtures";

/**
 * Regression test for the Stingerloom RelationLoader bug where joining the
 * same target entity twice (Issue → assignee + reporter, both → User) used
 * the table name as the JOIN alias and tripped MariaDB's
 * "ER_NONUNIQ_TABLE: Not unique table/alias" error.
 *
 * The fix in `EntityManager.ts` aliases each ManyToOne JOIN by the relation's
 * property name (e.g. `LEFT JOIN user AS assignee`, `LEFT JOIN user AS
 * reporter`) so the SELECT can pull both rows simultaneously.
 *
 * This file exists as the canary: if the bug returns, every dependent test
 * crashes here.
 */
integrationDescribe("Issues — relations: multi-FK to same target (regression)", () => {
  let booted: BootedApp;
  let fx: BaseFixture;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
  }, 60_000);

  afterAll(async () => {
    await shutdownApp(booted);
  });

  it("loads assignee + reporter + sprint + parent simultaneously", async () => {
    const auth = `Bearer ${fx.ownerToken}`;

    // Create a parent issue, then a child whose assignee != reporter.
    const parent = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Parent epic",
    });

    const issue = await request(booted.server)
      .post("/issues")
      .set("Authorization", auth)
      .send({
        projectId: fx.projectId,
        title: "Child issue with distinct assignee + reporter",
        assigneeId: fx.userIds[1],
        parentId: parent.id,
      })
      .expect(201);

    // GET /issues/:id triggers `findOne` which loads
    // ["labels","assignee","reporter","sprint","parent"]. Without the
    // RelationLoader fix this query fails on MariaDB.
    const r = await request(booted.server)
      .get(`/issues/${issue.body.id}`)
      .set("Authorization", auth)
      .expect(200);

    expect(r.body.id).toBe(issue.body.id);
    expect(r.body.parent?.id ?? r.body.parentId).toBeDefined();
    // assigneeId is the FK; the ORM populates `assignee` when the relation
    // loads. Either is acceptable for this assertion — the point is the
    // request didn't 500 with "Not unique table/alias".
    expect(r.body.assigneeId ?? r.body.assignee?.id).toBe(fx.userIds[1]);
    expect(r.body.reporterId ?? r.body.reporter?.id).toBe(fx.ownerId);
  });
});
