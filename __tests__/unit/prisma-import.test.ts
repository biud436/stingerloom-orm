/* eslint-disable @typescript-eslint/no-explicit-any */
import { TypeMapper } from "../../src/integration/prisma-import/TypeMapper";
import {
  PrismaSchemaAnalyzer,
  PrismaImportContext,
  PrismaModelInfo,
  PrismaFieldInfo,
  PrismaEnumInfo,
} from "../../src/integration/prisma-import/PrismaSchemaAnalyzer";
import { RelationResolver } from "../../src/integration/prisma-import/RelationResolver";
import { EntityCodeGenerator } from "../../src/integration/prisma-import/EntityCodeGenerator";
import { PrismaImporter } from "../../src/integration/prisma-import/PrismaImporter";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ─── AST Helper ───
// Parse prisma schemas in a child process to avoid ESM/Jest issues with chevrotain.
// Uses a temp file instead of `node -e '...'` for Windows shell compatibility.
function parsePrismaSchema(schema: string): any {
  const script = `
    const { getSchema } = require("@mrleebo/prisma-ast");
    const schema = ${JSON.stringify(schema)};
    process.stdout.write(JSON.stringify(getSchema(schema)));
  `;
  const projectRoot = path.resolve(__dirname, "../..");
  const tmpFile = path.join(projectRoot, `.prisma-parse-${process.pid}-${Date.now()}.js`);
  try {
    fs.writeFileSync(tmpFile, script, "utf-8");
    const result = execSync(`node "${tmpFile}"`, {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    return JSON.parse(result);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── Test Schemas ───

const BLOG_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  USER
  MODERATOR
}

enum PostStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  profile   Profile?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Post {
  id        Int        @id @default(autoincrement())
  title     String
  content   String?    @db.Text
  published Boolean    @default(false)
  status    PostStatus @default(DRAFT)
  authorId  Int
  author    User       @relation(fields: [authorId], references: [id])
  tags      Tag[]
  createdAt DateTime   @default(now())
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String?
  userId Int    @unique
  user   User   @relation(fields: [userId], references: [id])
}

model Tag {
  id    Int    @id @default(autoincrement())
  name  String @unique
  posts Post[]
}
`;

const MAP_SCHEMA = `
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model BlogPost {
  id    Int    @id @default(autoincrement())
  title String @map("post_title") @db.VarChar(200)
  slug  String

  @@map("blog_posts")
  @@unique([title, slug])
  @@index([slug])
}
`;

const COMPOSITE_PK_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model OrderItem {
  orderId   Int
  productId Int
  quantity  Int

  @@id([orderId, productId])
}
`;

const CASCADE_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Parent {
  id       Int    @id @default(autoincrement())
  children Child[]
}

model Child {
  id       Int    @id @default(autoincrement())
  parentId Int
  parent   Parent @relation(fields: [parentId], references: [id], onDelete: Cascade)
}
`;

const SELF_REFERENCING_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Category {
  id       Int        @id @default(autoincrement())
  name     String
  parentId Int?
  parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id])
  children Category[] @relation("CategoryTree")
}
`;

const NATIVE_TYPES_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model TypeTest {
  id         Int      @id @default(autoincrement())
  varchar100 String   @db.VarChar(100)
  char5      String   @db.Char(5)
  text       String   @db.Text
  timestampz DateTime @db.Timestamptz
  jsonData   Json
  blobData   Bytes
  bigNum     BigInt
  price      Decimal  @db.Decimal(10, 2)
}
`;

// ─── Cached parsed ASTs ───
let blogAst: any;
let mapAst: any;
let compositePkAst: any;
let cascadeAst: any;
let selfRefAst: any;
let nativeTypesAst: any;

beforeAll(() => {
  blogAst = parsePrismaSchema(BLOG_SCHEMA);
  mapAst = parsePrismaSchema(MAP_SCHEMA);
  compositePkAst = parsePrismaSchema(COMPOSITE_PK_SCHEMA);
  cascadeAst = parsePrismaSchema(CASCADE_SCHEMA);
  selfRefAst = parsePrismaSchema(SELF_REFERENCING_SCHEMA);
  nativeTypesAst = parsePrismaSchema(NATIVE_TYPES_SCHEMA);
});

// Helper to parse and analyze
function analyzeAst(ast: any) {
  const analyzer = new PrismaSchemaAnalyzer();
  return analyzer.analyze(ast);
}

// Helper to resolve relations
function resolveRelations(ast: any) {
  const ctx = analyzeAst(ast);
  const resolver = new RelationResolver();
  return { ctx, relations: resolver.resolve(ctx) };
}

// Helper to generate files
function generateFiles(ast: any): Map<string, string> {
  const { ctx, relations } = resolveRelations(ast);
  const generator = new EntityCodeGenerator(ctx, relations);
  return generator.generateAll();
}

// ─── TypeMapper Tests ───

describe("TypeMapper", () => {
  it("should map basic Prisma types", () => {
    const mapper = new TypeMapper("postgresql", new Map());

    expect(mapper.map("String").columnType).toBe("varchar");
    expect(mapper.map("Int").columnType).toBe("int");
    expect(mapper.map("Boolean").columnType).toBe("boolean");
    expect(mapper.map("DateTime").columnType).toBe("datetime");
    expect(mapper.map("Float").columnType).toBe("float");
    expect(mapper.map("BigInt").columnType).toBe("bigint");
    expect(mapper.map("Decimal").columnType).toBe("double");
    expect(mapper.map("Bytes").columnType).toBe("blob");
  });

  it("should map Json to jsonb for postgresql", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    expect(mapper.map("Json").columnType).toBe("jsonb");
  });

  it("should map Json to json for mysql", () => {
    const mapper = new TypeMapper("mysql", new Map());
    expect(mapper.map("Json").columnType).toBe("json");
  });

  it("should map enum types", () => {
    const enums = new Map([["Role", ["ADMIN", "USER"]]]);
    const mapper = new TypeMapper("postgresql", enums);
    const result = mapper.map("Role");
    expect(result.columnType).toBe("enum");
    expect(result.enumName).toBe("Role");
    expect(result.enumValues).toEqual(["ADMIN", "USER"]);
  });

  it("should handle @db.VarChar(n)", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("String", { name: "VarChar", args: [100] });
    expect(result.columnType).toBe("varchar");
    expect(result.length).toBe(100);
  });

  it("should handle @db.Char(n)", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("String", { name: "Char", args: [5] });
    expect(result.columnType).toBe("char");
    expect(result.length).toBe(5);
  });

  it("should handle @db.Text", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("String", { name: "Text", args: [] });
    expect(result.columnType).toBe("text");
  });

  it("should handle @db.Timestamptz", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("DateTime", { name: "Timestamptz", args: [] });
    expect(result.columnType).toBe("timestamptz");
  });

  it("should handle @db.Decimal(p, s)", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("Decimal", { name: "Decimal", args: [10, 2] });
    expect(result.columnType).toBe("double");
    expect(result.precision).toBe(10);
    expect(result.scale).toBe(2);
  });

  it("should handle @db.Jsonb", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("Json", { name: "Jsonb", args: [] });
    expect(result.columnType).toBe("jsonb");
  });

  it("should fall back to base type for unknown native hint", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    const result = mapper.map("String", { name: "UnknownType", args: [] });
    expect(result.columnType).toBe("varchar");
  });

  it("should map default varchar length to 255", () => {
    const mapper = new TypeMapper("postgresql", new Map());
    expect(mapper.map("String").length).toBe(255);
  });
});

// ─── PrismaSchemaAnalyzer Tests ───

describe("PrismaSchemaAnalyzer", () => {
  it("should detect datasource provider", () => {
    const ctx = analyzeAst(blogAst);
    expect(ctx.provider).toBe("postgresql");
  });

  it("should detect mysql provider", () => {
    const ctx = analyzeAst(mapAst);
    expect(ctx.provider).toBe("mysql");
  });

  it("should extract enums", () => {
    const ctx = analyzeAst(blogAst);
    expect(ctx.enums).toHaveLength(2);

    const role = ctx.enums.find((e) => e.name === "Role");
    expect(role).toBeDefined();
    expect(role!.values).toEqual(["ADMIN", "USER", "MODERATOR"]);

    const status = ctx.enums.find((e) => e.name === "PostStatus");
    expect(status).toBeDefined();
    expect(status!.values).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });

  it("should extract models", () => {
    const ctx = analyzeAst(blogAst);
    expect(ctx.models).toHaveLength(4);
    expect(ctx.models.map((m) => m.name).sort()).toEqual([
      "Post",
      "Profile",
      "Tag",
      "User",
    ]);
  });

  it("should detect @id fields", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const idField = user.fields.find((f) => f.name === "id")!;
    expect(idField.isId).toBe(true);
    expect(idField.defaultValue).toEqual({
      kind: "function",
      name: "autoincrement",
    });
  });

  it("should detect @unique fields", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const email = user.fields.find((f) => f.name === "email")!;
    expect(email.isUnique).toBe(true);
  });

  it("should detect optional fields", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const name = user.fields.find((f) => f.name === "name")!;
    expect(name.isOptional).toBe(true);
  });

  it("should detect @updatedAt", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const updatedAt = user.fields.find((f) => f.name === "updatedAt")!;
    expect(updatedAt.isUpdatedAt).toBe(true);
  });

  it("should detect @default(now())", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const createdAt = user.fields.find((f) => f.name === "createdAt")!;
    expect(createdAt.defaultValue).toEqual({
      kind: "function",
      name: "now",
    });
  });

  it("should detect @default(literal)", () => {
    const ctx = analyzeAst(blogAst);
    const post = ctx.models.find((m) => m.name === "Post")!;
    const published = post.fields.find((f) => f.name === "published")!;
    expect(published.defaultValue).toEqual({
      kind: "literal",
      value: false,
    });
  });

  it("should detect @default(enum literal)", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const role = user.fields.find((f) => f.name === "role")!;
    expect(role.defaultValue).toEqual({
      kind: "literal",
      value: "USER",
    });
  });

  it("should detect @relation", () => {
    const ctx = analyzeAst(blogAst);
    const post = ctx.models.find((m) => m.name === "Post")!;
    const author = post.fields.find((f) => f.name === "author")!;
    expect(author.relation).toBeDefined();
    expect(author.relation!.fields).toEqual(["authorId"]);
    expect(author.relation!.references).toEqual(["id"]);
  });

  it("should detect array fields", () => {
    const ctx = analyzeAst(blogAst);
    const user = ctx.models.find((m) => m.name === "User")!;
    const posts = user.fields.find((f) => f.name === "posts")!;
    expect(posts.isArray).toBe(true);
    expect(posts.fieldType).toBe("Post");
  });

  it("should detect @db.* native type hints", () => {
    const ctx = analyzeAst(blogAst);
    const post = ctx.models.find((m) => m.name === "Post")!;
    const content = post.fields.find((f) => f.name === "content")!;
    expect(content.nativeType).toBeDefined();
    expect(content.nativeType!.name).toBe("Text");
  });

  it("should handle @@map", () => {
    const ctx = analyzeAst(mapAst);
    const post = ctx.models.find((m) => m.name === "BlogPost")!;
    expect(post.tableName).toBe("blog_posts");
  });

  it("should handle @map on fields", () => {
    const ctx = analyzeAst(mapAst);
    const post = ctx.models.find((m) => m.name === "BlogPost")!;
    const title = post.fields.find((f) => f.name === "title")!;
    expect(title.columnName).toBe("post_title");
  });

  it("should handle @db.VarChar with args", () => {
    const ctx = analyzeAst(mapAst);
    const post = ctx.models.find((m) => m.name === "BlogPost")!;
    const title = post.fields.find((f) => f.name === "title")!;
    expect(title.nativeType!.name).toBe("VarChar");
    expect(title.nativeType!.args).toEqual([200]);
  });

  it("should handle @@unique", () => {
    const ctx = analyzeAst(mapAst);
    const post = ctx.models.find((m) => m.name === "BlogPost")!;
    expect(post.uniqueConstraints).toEqual([["title", "slug"]]);
  });

  it("should handle @@index", () => {
    const ctx = analyzeAst(mapAst);
    const post = ctx.models.find((m) => m.name === "BlogPost")!;
    expect(post.indexes).toEqual([["slug"]]);
  });

  it("should handle @@id composite primary key", () => {
    const ctx = analyzeAst(compositePkAst);
    const orderItem = ctx.models.find((m) => m.name === "OrderItem")!;
    expect(orderItem.compositeId).toEqual(["orderId", "productId"]);
  });

  it("should detect onDelete: Cascade in relations", () => {
    const ctx = analyzeAst(cascadeAst);
    const child = ctx.models.find((m) => m.name === "Child")!;
    const parent = child.fields.find((f) => f.name === "parent")!;
    expect(parent.relation!.onDelete).toBe("Cascade");
  });

  it("should handle named relations", () => {
    const ctx = analyzeAst(selfRefAst);
    const cat = ctx.models.find((m) => m.name === "Category")!;
    const parent = cat.fields.find((f) => f.name === "parent")!;
    expect(parent.relation!.name).toBe("CategoryTree");
    const children = cat.fields.find((f) => f.name === "children")!;
    expect(children.isArray).toBe(true);
  });

  it("should detect native types in TypeTest model", () => {
    const ctx = analyzeAst(nativeTypesAst);
    const model = ctx.models.find((m) => m.name === "TypeTest")!;

    const varchar100 = model.fields.find((f) => f.name === "varchar100")!;
    expect(varchar100.nativeType).toEqual({ name: "VarChar", args: [100] });

    const char5 = model.fields.find((f) => f.name === "char5")!;
    expect(char5.nativeType).toEqual({ name: "Char", args: [5] });

    const timestampz = model.fields.find((f) => f.name === "timestampz")!;
    expect(timestampz.nativeType).toEqual({ name: "Timestamptz", args: [] });

    const price = model.fields.find((f) => f.name === "price")!;
    expect(price.nativeType).toEqual({ name: "Decimal", args: [10, 2] });
  });
});

// ─── RelationResolver Tests ───

describe("RelationResolver", () => {
  it("should resolve ManyToOne + OneToMany (User-Post)", () => {
    const { relations } = resolveRelations(blogAst);

    const postRels = relations.get("Post")!;
    const m2o = postRels.find((r) => r.kind === "ManyToOne");
    expect(m2o).toBeDefined();
    expect(m2o!.targetModel).toBe("User");
    expect((m2o as any).joinColumn).toBe("authorId");

    const userRels = relations.get("User")!;
    const o2m = userRels.find((r) => r.kind === "OneToMany");
    expect(o2m).toBeDefined();
    expect(o2m!.targetModel).toBe("Post");
    expect((o2m as any).mappedBy).toBe("author");
  });

  it("should resolve OneToOne (User-Profile)", () => {
    const { relations } = resolveRelations(blogAst);

    const profileRels = relations.get("Profile")!;
    const owning = profileRels.find((r) => r.kind === "OneToOneOwning");
    expect(owning).toBeDefined();
    expect(owning!.targetModel).toBe("User");
    expect((owning as any).joinColumn).toBe("userId");
  });

  it("should resolve implicit ManyToMany (Post-Tag)", () => {
    const { relations } = resolveRelations(blogAst);

    const postRels = relations.get("Post")!;
    const tagRels = relations.get("Tag")!;

    const postM2M = postRels.find(
      (r) => r.kind === "ManyToManyOwning" || r.kind === "ManyToManyInverse",
    );
    const tagM2M = tagRels.find(
      (r) => r.kind === "ManyToManyOwning" || r.kind === "ManyToManyInverse",
    );

    expect(postM2M).toBeDefined();
    expect(tagM2M).toBeDefined();

    // Alphabetically: Post < Tag, so Post is owning
    expect(postM2M!.kind).toBe("ManyToManyOwning");
    expect(tagM2M!.kind).toBe("ManyToManyInverse");

    if (postM2M!.kind === "ManyToManyOwning") {
      expect((postM2M as any).joinTableName).toBe("post_tag");
    }
  });

  it("should resolve cascade relations", () => {
    const { relations } = resolveRelations(cascadeAst);
    const childRels = relations.get("Child")!;
    const m2o = childRels.find((r) => r.kind === "ManyToOne");
    expect(m2o).toBeDefined();
    expect((m2o as any).cascade).toEqual(["delete"]);
  });

  it("should resolve self-referencing relations", () => {
    const { relations } = resolveRelations(selfRefAst);
    const catRels = relations.get("Category")!;
    expect(catRels.length).toBeGreaterThanOrEqual(1);

    const m2o = catRels.find((r) => r.kind === "ManyToOne");
    const o2m = catRels.find((r) => r.kind === "OneToMany");
    expect(m2o).toBeDefined();
    expect(o2m).toBeDefined();
    expect(m2o!.targetModel).toBe("Category");
    expect(o2m!.targetModel).toBe("Category");
  });
});

// ─── EntityCodeGenerator Tests ───

describe("EntityCodeGenerator", () => {
  it("should generate entity files for all models", () => {
    const files = generateFiles(blogAst);
    expect(files.has("user.entity.ts")).toBe(true);
    expect(files.has("post.entity.ts")).toBe(true);
    expect(files.has("profile.entity.ts")).toBe(true);
    expect(files.has("tag.entity.ts")).toBe(true);
    expect(files.has("index.ts")).toBe(true);
  });

  it("should generate enum files", () => {
    const files = generateFiles(blogAst);
    expect(files.has("role.enum.ts")).toBe(true);
    expect(files.has("post_status.enum.ts")).toBe(true);

    const roleContent = files.get("role.enum.ts")!;
    expect(roleContent).toContain('ADMIN = "ADMIN"');
    expect(roleContent).toContain('USER = "USER"');
    expect(roleContent).toContain('MODERATOR = "MODERATOR"');
  });

  it("should import decorators from @stingerloom/orm", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain('from "@stingerloom/orm"');
    expect(user).toContain("Entity");
    expect(user).toContain("PrimaryGeneratedColumn");
  });

  it("should generate @PrimaryGeneratedColumn for @id @default(autoincrement())", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain("@PrimaryGeneratedColumn()");
    expect(user).toContain("id!: number;");
  });

  it("should generate @CreateTimestamp for @default(now())", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain("@CreateTimestamp()");
    expect(user).toContain("createdAt!: Date;");
  });

  it("should generate @UpdateTimestamp for @updatedAt", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain("@UpdateTimestamp()");
    expect(user).toContain("updatedAt!: Date;");
  });

  it("should generate nullable columns", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain("nullable: true");
    expect(user).toContain("name!: string | null;");
  });

  it("should generate @Column with type: text for @db.Text", () => {
    const files = generateFiles(blogAst);
    const post = files.get("post.entity.ts")!;
    expect(post).toContain('type: "text"');
  });

  it("should generate @Column with default value", () => {
    const files = generateFiles(blogAst);
    const post = files.get("post.entity.ts")!;
    expect(post).toContain("default: false");
  });

  it("should generate enum column with enumName and enumValues", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain('type: "enum"');
    expect(user).toContain('enumName: "Role"');
    expect(user).toContain('enumValues: ["ADMIN", "USER", "MODERATOR"]');
    expect(user).toContain('default: "USER"');
  });

  it("should generate ManyToOne relation", () => {
    const files = generateFiles(blogAst);
    const post = files.get("post.entity.ts")!;
    expect(post).toContain("@ManyToOne");
    expect(post).toContain("() => User");
    expect(post).toContain('@RelationColumn({ name: "authorId" })');
    expect(post).not.toContain('joinColumn: "authorId"');
  });

  it("should generate OneToMany relation", () => {
    const files = generateFiles(blogAst);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain("@OneToMany");
    expect(user).toContain("() => Post");
    expect(user).toContain('mappedBy: "author"');
  });

  it("should generate OneToOne owning side", () => {
    const files = generateFiles(blogAst);
    const profile = files.get("profile.entity.ts")!;
    expect(profile).toContain("@OneToOne");
    expect(profile).toContain("() => User");
    expect(profile).toContain('@RelationColumn({ name: "userId" })');
    expect(profile).not.toContain('joinColumn: "userId"');
  });

  it("should generate ManyToMany with joinTable", () => {
    const files = generateFiles(blogAst);
    const post = files.get("post.entity.ts")!;
    expect(post).toContain("@ManyToMany");
    expect(post).toContain("() => Tag");
    expect(post).toContain("joinTable:");
  });

  it("should generate ManyToMany inverse with mappedBy", () => {
    const files = generateFiles(blogAst);
    const tag = files.get("tag.entity.ts")!;
    expect(tag).toContain("@ManyToMany");
    expect(tag).toContain("() => Post");
    expect(tag).toContain("mappedBy:");
  });

  it("should import related entity files", () => {
    const files = generateFiles(blogAst);
    const post = files.get("post.entity.ts")!;
    expect(post).toContain('import { User } from "./user.entity.js"');
    expect(post).toContain('import { Tag } from "./tag.entity.js"');
  });

  it("should generate @Entity({ name }) for @@map", () => {
    const files = generateFiles(mapAst);
    const post = files.get("blog_post.entity.ts")!;
    expect(post).toContain('@Entity({ name: "blog_posts" })');
  });

  it("should generate @UniqueIndex for @@unique", () => {
    const files = generateFiles(mapAst);
    const post = files.get("blog_post.entity.ts")!;
    expect(post).toContain('@UniqueIndex(["title", "slug"])');
  });

  it("should generate @Column({ name }) for @map", () => {
    const files = generateFiles(mapAst);
    const post = files.get("blog_post.entity.ts")!;
    expect(post).toContain('name: "post_title"');
  });

  it("should generate @Column with length for @db.VarChar", () => {
    const files = generateFiles(mapAst);
    const post = files.get("blog_post.entity.ts")!;
    expect(post).toContain("length: 200");
  });

  it("should generate @PrimaryColumn for @@id composite", () => {
    const files = generateFiles(compositePkAst);
    const item = files.get("order_item.entity.ts")!;
    expect(item).toContain("@PrimaryColumn()");
    const matches = item.match(/@PrimaryColumn/g);
    expect(matches).toHaveLength(2);
  });

  it("should generate cascade option", () => {
    const files = generateFiles(cascadeAst);
    const child = files.get("child.entity.ts")!;
    expect(child).toContain('cascade: ["delete"]');
  });

  it("should handle self-referencing entity", () => {
    const files = generateFiles(selfRefAst);
    const category = files.get("category.entity.ts")!;
    expect(category).toContain("() => Category");
    expect(category).toContain("@ManyToOne");
    expect(category).toContain("@OneToMany");
  });

  it("should generate barrel index.ts", () => {
    const files = generateFiles(blogAst);
    const index = files.get("index.ts")!;
    expect(index).toContain('export * from "./user.entity.js"');
    expect(index).toContain('export * from "./post.entity.js"');
    expect(index).toContain('export * from "./role.enum.js"');
    expect(index).toContain('export * from "./post_status.enum.js"');
  });

  it("should skip FK fields that are covered by relations", () => {
    const files = generateFiles(blogAst);
    const post = files.get("post.entity.ts")!;
    const columnAuthorId = post.match(/@Column\([^)]*\)\s*\n\s*authorId/);
    expect(columnAuthorId).toBeNull();
  });

  it("should generate native types correctly", () => {
    const files = generateFiles(nativeTypesAst);
    const test = files.get("type_test.entity.ts")!;
    expect(test).toContain("length: 100"); // varchar100
    expect(test).toContain('type: "char"'); // char5
    expect(test).toContain('type: "text"'); // text
    expect(test).toContain('type: "timestamptz"'); // timestampz
    expect(test).toContain('type: "jsonb"'); // jsonData
    expect(test).toContain('type: "blob"'); // blobData
    expect(test).toContain('type: "bigint"'); // bigNum
    expect(test).toContain("precision: 10"); // price
    expect(test).toContain("scale: 2"); // price
  });
});

// ─── Full Pipeline Tests ───

describe("Full pipeline", () => {
  it("should generate complete entity files from blog schema", () => {
    const files = generateFiles(blogAst);

    expect(files.size).toBeGreaterThanOrEqual(7); // 4 entities + 2 enums + index

    const user = files.get("user.entity.ts")!;
    expect(user).toBeDefined();
    expect(user).toContain("export class User");
    expect(user).toContain("@Entity()");
    expect(user).toContain("@PrimaryGeneratedColumn()");
    expect(user).toContain("id!: number");
    expect(user).toContain("email!: string");
    expect(user).toContain("@CreateTimestamp()");
    expect(user).toContain("@UpdateTimestamp()");
  });

  it("should generate valid TS for the full blog schema", () => {
    const files = generateFiles(blogAst);

    for (const [name, content] of files) {
      if (name === "index.ts") continue;
      if (name.endsWith(".enum.ts")) {
        expect(content).toContain("export enum");
      } else {
        expect(content).toContain("export class");
        expect(content).toContain("@Entity");
      }
    }
  });

  it("should handle composite PK schema", () => {
    const files = generateFiles(compositePkAst);
    const item = files.get("order_item.entity.ts")!;
    expect(item).toContain("@PrimaryColumn()");
  });

  it("should handle @@map schema", () => {
    const files = generateFiles(mapAst);
    const post = files.get("blog_post.entity.ts")!;
    expect(post).toContain('@Entity({ name: "blog_posts" })');
    expect(post).toContain('name: "post_title"');
  });
});

// ─── Edge Cases ───

describe("Edge cases", () => {
  it("should handle schema with no relations", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Simple {
  id   Int    @id @default(autoincrement())
  name String
  age  Int
}
`);
    const files = generateFiles(ast);
    const simple = files.get("simple.entity.ts")!;
    expect(simple).toContain("export class Simple");
    expect(simple).toContain("@PrimaryGeneratedColumn()");
    expect(simple).toContain("name!: string;");
    expect(simple).toContain("age!: number;");
  });

  it("should handle schema with only enums", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Color {
  RED
  GREEN
  BLUE
}

model Item {
  id    Int   @id @default(autoincrement())
  color Color
}
`);
    const files = generateFiles(ast);
    expect(files.has("color.enum.ts")).toBe(true);
    const item = files.get("item.entity.ts")!;
    expect(item).toContain('type: "enum"');
    expect(item).toContain('enumName: "Color"');
  });

  it("should map @id @default(uuid()) to @PrimaryGeneratedColumn(\"uuid\")", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model UuidModel {
  id   String @id @default(uuid())
  name String
}
`);
    const files = generateFiles(ast);
    const model = files.get("uuid_model.entity.ts")!;
    expect(model).toContain('@PrimaryGeneratedColumn("uuid")');
    expect(model).toContain("id!: string;");
    expect(model).not.toContain("TODO");
    // The import must follow the decorator swap
    expect(model).toContain("PrimaryGeneratedColumn");
    expect(model).not.toContain("@PrimaryColumn");
  });

  it("should keep varchar PK with explicit NOTE for @id @default(cuid())", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model CuidModel {
  id   String @id @default(cuid())
  name String
}
`);
    const files = generateFiles(ast);
    const model = files.get("cuid_model.entity.ts")!;
    expect(model).toContain('@PrimaryColumn({ type: "varchar", length: 36 })');
    expect(model).toContain("NOTE: Prisma @default(cuid()) has no Stingerloom equivalent");
    expect(model).toContain("assign the id in application code");
  });

  it("should surface unmapped function defaults on non-id columns", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Token {
  id    Int    @id @default(autoincrement())
  value String @default(uuid())
}
`);
    const files = generateFiles(ast);
    const model = files.get("token.entity.ts")!;
    expect(model).toContain("NOTE: Prisma @default(uuid()) is not mapped");
    expect(model).toContain("@Column");
  });

  it("should handle no datasource (defaults to postgresql)", () => {
    const ast = parsePrismaSchema(`
model Simple {
  id   Int    @id @default(autoincrement())
  name String
}
`);
    const files = generateFiles(ast);
    expect(files.has("simple.entity.ts")).toBe(true);
  });

  it("should handle @unique on field", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`);
    const files = generateFiles(ast);
    const user = files.get("user.entity.ts")!;
    expect(user).toContain("email!: string;");
  });

  it("should generate import for enum from enum file", () => {
    const ast = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Status {
  ACTIVE
  INACTIVE
}

model Account {
  id     Int    @id @default(autoincrement())
  status Status @default(ACTIVE)
}
`);
    const files = generateFiles(ast);
    const account = files.get("account.entity.ts")!;
    expect(account).toContain('import { Status } from "./status.enum.js"');
  });
});
