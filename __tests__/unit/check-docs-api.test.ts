import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "../../scripts/check-docs-api.js");

/** Runs the checker on the given markdown files; returns its exit code and output lines. */
function check(...files: string[]): { status: number; lines: string[] } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...files], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, lines: out.trim().split("\n") };
  } catch (error) {
    const failed = error as { status: number; stderr: string };
    return { status: failed.status, lines: failed.stderr.trim().split("\n") };
  }
}

const fence = (code: string) => "```typescript\n" + code.trim() + "\n```\n";

describe("check-docs-api", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-api-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  /** The reported messages, without the `file:line` prefix. */
  const messages = (lines: string[]) =>
    lines.filter((l) => l.includes("  ")).map((l) => l.slice(l.indexOf("  ") + 2));

  it("reports samples that do not match the API in src/", () => {
    const file = write(
      "samples.md",
      [
        fence(`
import { BaseRepository, InjectRepository } from "@stingerloom/orm/nestjs";

await em.findMany(User);
await em.attachRelation(post, "tags", tag);
await em.register({ type: "postgresql", hots: "localhost" });
const page = await em.findWithCursor(User, { take: 10 });
console.log(page.items);
`),
        fence(`
const runner = new MigrationRunner(driver, migrations, { hooks: {} });
const client = new DatabaseClient();

@Entity()
@UniqueIndex(["categoryId", "slug"], { name: "uq_post_category_slug" })
class Post {
  @ManyToOne(() => User, { joinColumn: "author_id" }) author!: User;
}

@Entity()
class User {
  @OneToMany(() => Post, (post) => post.author) posts!: Post[];
}

interface SchemaDiffResult {
  addedTables: string[];
}
`),
      ].join("\n"),
    );

    const { status, lines } = check(file);

    expect(status).toBe(1);
    expect(messages(lines)).toEqual([
      'BaseRepository is not exported from "@stingerloom/orm/nestjs" (it is exported from "@stingerloom/orm")',
      "EntityManager.findMany() does not exist",
      "EntityManager.attachRelation() takes 4-5 argument(s); the sample passes 3",
      `'type: "postgresql"' is not accepted by EntityManager.register(); it takes "mysql", "mariadb", "postgres", "sqlite"`,
      "'hots' is not an option of argument 1 of EntityManager.register()",
      "CursorPaginationResult.items does not exist",
      "MigrationRunner is abstract; the sample constructs it",
      "DatabaseClient has no public constructor; the sample constructs it",
      "argument 2 of @UniqueIndex() takes a value, not an options object; the sample passes an object",
      "argument 2 of @ManyToOne() takes a function; the sample passes an object",
      "argument 2 of @OneToMany() takes an options object; the sample passes a function",
      "SchemaDiffResult.addedTables does not exist",
    ]);
    // Locations point at the markdown line of the offending code.
    expect(lines[0]).toMatch(/samples\.md:2 /);
  });

  it("reports api-reference rows that do not match the source", () => {
    const file = write(
      "api-reference.md",
      [
        "## EntityManager",
        "",
        "| Method | Signature | Description |",
        "|--------|-----------|-------------|",
        "| `attachRelation` | `<T, U>(parent: T, relation: keyof T & string, child: U): Promise<void>` | |",
        "| `find` | `<T>(entity, option?): Promise<T[]>` | |",
        "| `findEverything` | `(): void` | |",
        "",
        "## Decorators",
        "",
        "| Decorator | Description |",
        "|-----------|-------------|",
        "| `@ManyToOne(getEntity, getProperty?, option?)` | |",
        "| `@Column(opts)` | |",
        "",
        "## Utilities",
        "",
        "| Export | Description |",
        "|--------|-------------|",
        "| `MetadataLayerRegistry` | |",
        "| `MetadataContext` | |",
        "",
      ].join("\n"),
    );

    const { status, lines } = check(file);

    expect(status).toBe(1);
    expect(messages(lines)).toEqual([
      "EntityManager.attachRelation(parent: T, relation: keyof T & string, child: U): Promise<void> does not match its parameters (takes 4-5 argument(s))",
      "EntityManager.findEverything does not exist",
      "@ManyToOne(getEntity, getProperty?, option?) does not match its parameters (takes 2-3 argument(s))",
      "MetadataLayerRegistry is not exported from the package",
    ]);
  });

  it("accepts matching samples, follows a page's declarations and skips marked blocks", () => {
    const file = write(
      "valid.md",
      [
        fence(`
import { MultiTenantEntityManager, qAlias } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";

const em = new MultiTenantEntityManager();
`),
        // A later block on the same page still sees the manager declared above.
        fence(`
const counts = await em.forEachTenant(async (tenantEm) => tenantEm.count(User));
const u = qAlias(User, "u");
const rows = await em.find(User, { where: { isActive: true }, take: 10 });
`),
        "<!-- check-docs-api: skip -->",
        "",
        fence(`
await em.thisMethodDoesNotExist();
`),
      ].join("\n"),
    );

    const { status, lines } = check(file);

    expect(lines).toEqual(["check-docs-api: scanned 1 files, 0 mismatch(es)"]);
    expect(status).toBe(0);
  });
});
