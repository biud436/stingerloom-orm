import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  OneToOne,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class Author {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: "varchar", length: 255 })
  firstName!: string;
  @Column({ type: "varchar", length: 255 })
  lastName!: string;
  @Column({ type: "int" })
  age!: number;
  @OneToMany(() => Article, { mappedBy: "author" })
  articles!: Article[];
}

@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: "varchar", length: 255 })
  title!: string;
  @Column({ type: "varchar", length: 50 })
  status!: string;
  @Column({ type: "int" })
  authorId!: number;
  @ManyToOne(() => Author, (e: any) => e.author)
  author!: Author;
  @OneToMany(() => Comment, { mappedBy: "article" })
  comments!: Comment[];
}

@Entity()
class Comment {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: "text" })
  content!: string;
  @Column({ type: "int" })
  articleId!: number;
  @Column({ type: "timestamp" })
  createdAt!: Date;
  @ManyToOne(() => Article, (e: any) => e.article)
  article!: Article;
}

@Entity()
class Profile {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: "varchar" })
  bio!: string;
  @Column({ type: "int" })
  authorId!: number;
  @OneToOne(() => Author)
  author!: Author;
}

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
    return `"${col.replace(/"/g, '""')}"`;
  }
  const em = {
    wrap,
    wrapTable(tableName: string) { return wrap(tableName); },
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
      getDialect: () => (dbType === "mysql" ? "mysql" : "postgresql"),
    },
    async query<T>(): Promise<T[]> { return [] as T[]; },
  } as unknown as EntityManager;
  return em;
}

function createQb<T>(entity: new () => T, alias: string, dbType: "mysql" | "postgresql" = "mysql") {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<T>(entity as any, alias, em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(entity as any);
  if (meta) {
    const map = new Map<string, string>();
    for (const col of meta.columns) {
      const prop = (col as any).propertyKey ?? col.name!;
      map.set(prop, col.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  return { qb, em };
}

describe("SelectQueryBuilder — subquery integration", () => {
  // ── whereInSubquery ──────────────────────────────────────

  describe("whereInSubquery", () => {
    it("should generate WHERE col IN (subquery)", () => {
      const { qb: subQb } = createQb(Author, "a2");
      subQb.select(["id"]).where("age", ">", 30);

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.whereInSubquery("authorId", subQb);
      const { text, values } = mainQb.getSql();

      expect(text).toContain("IN");
      // The subquery should contain a SELECT for id
      expect(text).toMatch(/SELECT/i);
      // The parameter value 30 should be present
      expect(values).toContain(30);
    });

    it("should resolve column via alias registry", () => {
      const { qb: subQb } = createQb(Author, "a2");
      subQb.select(["id"]).where("firstName", "Alice");

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.whereInSubquery("authorId", subQb);
      const { text } = mainQb.getSql();

      // The main column should be properly qualified with the alias
      expect(text).toMatch(/`ar`\.`authorId`|"ar"\."authorId"/);
    });
  });

  // ── whereNotInSubquery ───────────────────────────────────

  describe("whereNotInSubquery", () => {
    it("should generate WHERE col NOT IN (subquery)", () => {
      const { qb: subQb } = createQb(Author, "a2");
      subQb.select(["id"]).where("age", "<", 18);

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.whereNotInSubquery("authorId", subQb);
      const { text, values } = mainQb.getSql();

      expect(text).toContain("NOT IN");
      expect(text).toMatch(/SELECT/i);
      expect(values).toContain(18);
    });
  });

  // ── whereExistsSubquery ──────────────────────────────────

  describe("whereExistsSubquery", () => {
    it("should generate WHERE EXISTS (subquery)", () => {
      const { qb: subQb } = createQb(Article, "ar2");
      subQb.select(["id"]).where("status", "active");

      const { qb: mainQb } = createQb(Author, "a");
      mainQb.whereExistsSubquery(subQb);
      const { text, values } = mainQb.getSql();

      expect(text).toContain("EXISTS");
      expect(values).toContain("active");
    });

    it("should chain with other WHERE conditions", () => {
      const { qb: subQb } = createQb(Article, "ar2");
      subQb.select(["id"]).where("status", "active");

      const { qb: mainQb } = createQb(Author, "a");
      mainQb.where("age", ">", 25).whereExistsSubquery(subQb);
      const { text, values } = mainQb.getSql();

      // Should have both the age condition AND the EXISTS clause
      expect(text).toContain("EXISTS");
      expect(text).toContain(">");
      expect(values).toContain(25);
      expect(values).toContain("active");
    });
  });

  // ── whereNotExistsSubquery ───────────────────────────────

  describe("whereNotExistsSubquery", () => {
    it("should generate WHERE NOT EXISTS (subquery)", () => {
      const { qb: subQb } = createQb(Comment, "c2");
      subQb.select(["id"]).where("content", "LIKE", "%spam%");

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.whereNotExistsSubquery(subQb);
      const { text, values } = mainQb.getSql();

      expect(text).toContain("NOT EXISTS");
      expect(values).toContain("%spam%");
    });
  });

  // ── addSelectSubquery ────────────────────────────────────

  describe("addSelectSubquery", () => {
    it("should add scalar subquery to SELECT clause", () => {
      const { qb: subQb } = createQb(Comment, "c");
      subQb.addSelect(Conditions.count("*"), "cnt");

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.addSelectSubquery(subQb, "commentCount");
      const { text } = mainQb.getSql();

      // The SELECT should contain the subquery wrapped with the alias
      expect(text).toContain("commentCount");
      // Should contain a nested SELECT
      expect(text).toMatch(/\(SELECT .+\) AS/i);
    });

    it("should preserve parameter bindings", () => {
      const { qb: subQb } = createQb(Comment, "c");
      subQb.addSelect(Conditions.count("*"), "cnt").where("content", "LIKE", "%good%");

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.addSelectSubquery(subQb, "goodCommentCount");
      const { text, values } = mainQb.getSql();

      expect(text).toContain("goodCommentCount");
      // The parameterized value from the subquery should be in the final values
      expect(values).toContain("%good%");
    });
  });

  // ── clone with selectExpressions ─────────────────────────

  describe("clone", () => {
    it("should clone selectExpressions", () => {
      const { qb: subQb } = createQb(Comment, "c");
      subQb.addSelect(Conditions.count("*"), "cnt");

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.addSelectSubquery(subQb, "commentCount");

      const cloned = mainQb.clone();
      const { text: originalText } = mainQb.getSql();
      const { text: clonedText } = cloned.getSql();

      // Both should have the subquery expression
      expect(originalText).toContain("commentCount");
      expect(clonedText).toContain("commentCount");
    });

    it("should isolate cloned selectExpressions", () => {
      const { qb: subQb1 } = createQb(Comment, "c1");
      subQb1.addSelect(Conditions.count("*"), "cnt");

      const { qb: mainQb } = createQb(Article, "ar");
      mainQb.addSelectSubquery(subQb1, "commentCount");

      const cloned = mainQb.clone();

      // Add another subquery to the original AFTER cloning
      const { qb: subQb2 } = createQb(Comment, "c2");
      subQb2.addSelect(Conditions.count("*"), "cnt");
      mainQb.addSelectSubquery(subQb2, "extraCount");

      const { text: originalText } = mainQb.getSql();
      const { text: clonedText } = cloned.getSql();

      // Original should have both
      expect(originalText).toContain("commentCount");
      expect(originalText).toContain("extraCount");

      // Clone should only have the first one (not affected by later mutation)
      expect(clonedText).toContain("commentCount");
      expect(clonedText).not.toContain("extraCount");
    });
  });
});
