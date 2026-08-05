import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { Project, Todo } from "./entities";

/**
 * A plain-script tour of the code-first API against an in-memory SQLite
 * database. Run with `pnpm start` — no server, no external database.
 */
async function main(): Promise<void> {
  const em = new EntityManager();

  console.log("1. Schema sync — CREATE TABLE from the builders");
  await em.register({
    type: "sqlite",
    database: ":memory:",
    entities: [Project, Todo],
    synchronize: true,
  });

  console.log("\n2. Inserts — beforeInsert fills the slug, afterInsert logs");
  const inbox = await em.save(Project, new Project({ name: "Inbox" }));
  const shipIt = await em.save(
    Todo,
    new Todo({ title: "Ship the release", priority: "high", projectId: inbox.id }),
  );
  await em.save(
    Todo,
    new Todo({
      title: "Write the changelog",
      meta: { tags: ["docs", "release"] },
      projectId: inbox.id,
    }),
  );
  await em.save(
    Todo,
    new Todo({ title: "Clean up the backlog", priority: "low", projectId: inbox.id }),
  );

  console.log("\n3. Typed reads — relation loading and JSON round-trip");
  const inboxTodos = await em.find(Todo, {
    where: { projectId: inbox.id },
    relations: ["project"],
    orderBy: { slug: "ASC" },
  });
  console.log(
    `  ${inboxTodos.length} todos in "${inboxTodos[0]?.project?.name}":`,
    inboxTodos.map((todo) => `${todo.title} [${todo.priority}]`),
  );
  const documented = await em.findOne(Todo, { where: { title: "Write the changelog" } });
  console.log(`  meta.tags -> ${documented!.meta?.tags?.join(", ")} (typed, no cast)`);

  console.log("\n4. Update — updateTimestamp refreshes, version column tracks writes");
  const updated = await em.update(Todo, { id: shipIt.id }, { done: true });
  console.log(`  marked done: ${updated.affected} row(s)`);
  const done = await em.findOne(Todo, { where: { id: shipIt.id } });
  console.log(`  version ${shipIt.version} -> ${done!.version}, updatedAt ${done!.updatedAt}`);

  console.log("\n5. Soft delete — filtered out by default, visible on request");
  await em.softDelete(Todo, { id: shipIt.id });
  console.log(`  visible: ${await em.count(Todo)}`);
  console.log(`  including deleted: ${await em.count(Todo, undefined, true)}`);
  await em.restore(Todo, { id: shipIt.id });
  console.log(`  after restore: ${await em.count(Todo)}`);

  console.log("\n6. Queries — where + orderBy + take, exists");
  const open = await em.find(Todo, {
    where: { done: false },
    orderBy: { createdAt: "ASC" },
    take: 2,
  });
  console.log(`  first two open todos:`, open.map((todo) => todo.title));
  console.log(`  any open 'high'? ${await em.exists(Todo, { priority: "high", done: false })}`);

  await em.propagateShutdown({ closeConnections: true });
  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
