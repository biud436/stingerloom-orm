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

describe("SelectQueryBuilder — whereHas / whereNotHas / withCount / loadRelation", () => {
  // ── whereHas ─────────────────────────────────────────────

  describe("whereHas", () => {
    it("should generate EXISTS subquery for OneToMany relation", () => {
      const { qb } = createQb(Author, "a");
      qb.whereHas("articles");
      const { text } = qb.getSql();

      expect(text).toContain("EXISTS");
      expect(text).toContain("SELECT 1 FROM");
      // The subquery should reference the Article table
      expect(text).toMatch(/Article/i);
      // Correlation: inner alias FK = outer alias PK
      expect(text).toContain("=");
    });

    it("should generate EXISTS subquery for ManyToOne relation", () => {
      const { qb } = createQb(Article, "ar");
      qb.whereHas("author");
      const { text } = qb.getSql();

      expect(text).toContain("EXISTS");
      expect(text).toContain("SELECT 1 FROM");
      // The subquery should reference the Author table
      expect(text).toMatch(/Author/i);
      expect(text).toContain("=");
    });

    it("should apply additional conditions via callback", () => {
      const { qb } = createQb(Author, "a");
      qb.whereHas("articles", (sub) => sub.where("status", "published"));
      const { text, values } = qb.getSql();

      expect(text).toContain("EXISTS");
      expect(text).toContain("SELECT 1 FROM");
      // The subquery WHERE should have both the correlation AND the extra condition
      // There should be at least two conditions joined by AND in the subquery
      expect(text).toContain("AND");
      // The parameterized value "published" should be in the values array
      expect(values).toContain("published");
    });

    it("should throw for non-existent relation", () => {
      const { qb } = createQb(Author, "a");
      expect(() => qb.whereHas("nonexistent")).toThrow();
    });
  });

  // ── whereNotHas ──────────────────────────────────────────

  describe("whereNotHas", () => {
    it("should generate NOT EXISTS subquery", () => {
      const { qb } = createQb(Author, "a");
      qb.whereNotHas("articles");
      const { text } = qb.getSql();

      expect(text).toContain("NOT EXISTS");
      expect(text).toContain("SELECT 1 FROM");
    });

    it("should support callback with whereNotHas", () => {
      const { qb } = createQb(Article, "ar");
      qb.whereNotHas("comments", (sub) =>
        sub.where("content", "LIKE", "%spam%"),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("NOT EXISTS");
      expect(text).toContain("SELECT 1 FROM");
      expect(text).toContain("AND");
      expect(text).toContain("LIKE");
      expect(values).toContain("%spam%");
    });
  });

  // ── withCount ────────────────────────────────────────────

  describe("withCount", () => {
    it("should add COUNT subquery to SELECT", () => {
      const { qb } = createQb(Author, "a");
      qb.withCount("articles");
      const { text } = qb.getSql();

      expect(text).toContain("COUNT(*)");
      // Default alias: articles_count
      expect(text).toContain("articles_count");
    });

    it("should use custom alias for count", () => {
      const { qb } = createQb(Author, "a");
      qb.withCount("articles", "articleCount");
      const { text } = qb.getSql();

      expect(text).toContain("COUNT(*)");
      expect(text).toContain("articleCount");
      // Should NOT contain the default alias
      expect(text).not.toContain("articles_count");
    });

    it("should support filter callback in withCount", () => {
      const { qb } = createQb(Author, "a");
      qb.withCount("articles", "publishedCount", (sub) =>
        sub.where("status", "published"),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("COUNT(*)");
      expect(text).toContain("publishedCount");
      expect(text).toContain("AND");
      expect(values).toContain("published");
    });
  });

  // ── loadRelation ─────────────────────────────────────────

  describe("loadRelation", () => {
    it("should delegate to leftJoinRelationAndSelect", () => {
      const { qb } = createQb(Article, "ar");
      qb.loadRelation("author", "u");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN");
      // The joined table should be Author
      expect(text).toMatch(/Author/i);
      // The alias "u" should appear in the SQL
      expect(text).toContain("u");
    });

    it("should use relation name as default alias", () => {
      const { qb } = createQb(Article, "ar");
      qb.loadRelation("author");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN");
      // When no alias given, "author" is used as the alias
      expect(text).toMatch(/author/i);
    });
  });

  // ── OneToOne ─────────────────────────────────────────────

  describe("OneToOne relation", () => {
    it("should generate EXISTS subquery for OneToOne relation", () => {
      const { qb } = createQb(Profile, "p");
      qb.whereHas("author");
      const { text } = qb.getSql();

      expect(text).toContain("EXISTS");
      expect(text).toContain("SELECT 1 FROM");
      // The subquery should reference the Author table
      expect(text).toMatch(/Author/i);
      // Correlation condition
      expect(text).toContain("=");
    });
  });
});
