import "reflect-metadata";
import {
  SelectQueryBuilder,
  JoinOnBuilder,
  alias,
  qAlias,
  ColumnCondition,
  isEntityRef,
} from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  DeletedAt,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";

// ── Test Entities ──────────────────────────────────────────

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

  @ManyToOne(
    () => Author,
    (e: any) => e.author,
  )
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

  @ManyToOne(
    () => Article,
    (e: any) => e.article,
  )
  article!: Article;
}

@Entity()
class SoftEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

// ── Mock EntityManager ─────────────────────────────────────

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  const resolver = new RelationMetadataResolver();

  function wrap(col: string) {
    if (dbType === "mysql") {
      return `\`${col.replace(/`/g, "``")}\``;
    }
    return `"${col.replace(/"/g, '""')}"`;
  }

  const em = {
    wrap,
    wrapTable(tableName: string) {
      return wrap(tableName);
    },
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
      getDialect: () => (dbType === "mysql" ? "mysql" : "postgresql"),
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
  } as unknown as EntityManager;

  return em;
}

function createQb<T>(
  entity: new () => T,
  alias: string,
  dbType: "mysql" | "postgresql" = "mysql",
) {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<T>(entity as any, alias, em);
  // Build property-to-column map from entity metadata
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

// ── Tests ──────────────────────────────────────────────────

describe("SelectQueryBuilder — Entity-Aware Joins", () => {
  // ── Entity-aware JOIN with JoinOnBuilder ──

  describe("entity-aware LEFT JOIN", () => {
    it("should join with entity class and resolve property names (MySQL)", () => {
      const { qb } = createQb(Article, "a", "mysql");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("`a`.`authorId` = `au`.`id`");
    });

    it("should join with entity class and resolve property names (PostgreSQL)", () => {
      const { qb } = createQb(Article, "a", "postgresql");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain('LEFT JOIN "author" AS "au"');
      expect(text).toContain('"a"."authorId" = "au"."id"');
    });
  });

  describe("entity-aware INNER JOIN", () => {
    it("should generate INNER JOIN with entity class", () => {
      const { qb } = createQb(Article, "a");
      qb.innerJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN `author` AS `au`");
      expect(text).toContain("`a`.`authorId` = `au`.`id`");
    });
  });

  describe("entity-aware RIGHT JOIN", () => {
    it("should generate RIGHT JOIN with entity class", () => {
      const { qb } = createQb(Article, "a");
      qb.rightJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("RIGHT JOIN `author` AS `au`");
    });
  });

  describe("multiple entity JOINs (3-table chain)", () => {
    it("should chain Article → Author and Article → Comment", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      ).leftJoin(Comment, "c", (j) =>
        j.on("c.articleId", "=", "a.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("LEFT JOIN `comment` AS `c`");
      expect(text).toContain("`a`.`authorId` = `au`.`id`");
      expect(text).toContain("`c`.`articleId` = `a`.`id`");
    });
  });

  describe("self JOIN", () => {
    it("should join same entity with different aliases", () => {
      const { qb } = createQb(Author, "a1");
      qb.leftJoin(Author, "a2", (j) =>
        j.on("a1.id", "=", "a2.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `a2`");
      expect(text).toContain("`a1`.`id` = `a2`.`id`");
    });
  });

  describe("JoinOnBuilder — multiple conditions", () => {
    it("should combine multiple ON conditions with AND", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id").andOn("au.age", ">=", "a.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`authorId` = `au`.`id`");
      expect(text).toContain("`au`.`age` >= `a`.`id`");
      expect(text).toContain("AND");
    });
  });

  describe("JoinOnBuilder — onVal", () => {
    it("should compare column to literal value", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id").onVal("au.age", ">=", 18),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`age` >= ?");
      expect(values).toContain(18);
    });
  });

  // ── Relation-based JOIN ──

  describe("leftJoinRelation — ManyToOne", () => {
    it("should auto-create ON from @ManyToOne metadata", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoinRelation("author", "au");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      // ON condition: a.authorId = au.id
      expect(text).toContain("`a`.`authorId`");
      expect(text).toContain("`au`.`id`");
    });
  });

  describe("leftJoinRelation — OneToMany", () => {
    it("should auto-create ON from @OneToMany metadata", () => {
      const { qb } = createQb(Author, "au");
      qb.leftJoinRelation("articles", "a");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `article` AS `a`");
      // ON condition: au.id = a.authorId (reverse FK)
      expect(text).toContain("`au`.`id`");
      expect(text).toContain("`a`.");
    });
  });

  describe("innerJoinRelation", () => {
    it("should generate INNER JOIN from relation", () => {
      const { qb } = createQb(Article, "a");
      qb.innerJoinRelation("author", "au");
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN `author` AS `au`");
    });
  });

  describe("leftJoinRelation — unknown relation", () => {
    it("should throw OrmError for non-existent relation", () => {
      const { qb } = createQb(Article, "a");
      expect(() => qb.leftJoinRelation("nonexistent", "x")).toThrow(
        /No relation found for property "nonexistent"/,
      );
    });
  });

  // ── Cross-entity WHERE ──

  describe("cross-entity where()", () => {
    it("should resolve alias.property in where 2-arg (equals)", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.where("au.firstName", "John");
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`firstName` = ?");
      expect(values).toContain("John");
    });

    it("should resolve alias.property in where 3-arg (operator)", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.where("au.age", ">=", 18);
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`age` >= ?");
      expect(values).toContain(18);
    });

    it("should resolve alias.property in where LIKE", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.where("au.firstName", "LIKE", "%John%");
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`firstName` LIKE ?");
      expect(values).toContain("%John%");
    });
  });

  describe("cross-entity andWhere / orWhere", () => {
    it("should resolve alias.property in andWhere", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.where("a.status", "published");
      qb.andWhere("au.age", ">=", 18);
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`status` = ?");
      expect(text).toContain("`au`.`age` >= ?");
    });

    it("should resolve alias.property in orWhere", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.where("a.status", "published");
      qb.orWhere("au.firstName", "Admin");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`firstName` = ?");
      expect(text).toContain("OR");
    });
  });

  describe("cross-entity whereIn / whereNotIn", () => {
    it("should resolve alias.property in whereIn", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.whereIn("au.id", [1, 2, 3]);
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`id` IN");
      expect(values).toEqual([1, 2, 3]);
    });

    it("should resolve alias.property in whereNotIn", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.whereNotIn("au.id", [4, 5]);
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`id` NOT IN");
    });
  });

  describe("cross-entity whereNull / whereNotNull", () => {
    it("should resolve alias.property in whereNull", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.whereNull("au.firstName");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`firstName` IS NULL");
    });

    it("should resolve alias.property in whereNotNull", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.whereNotNull("au.firstName");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`firstName` IS NOT NULL");
    });
  });

  describe("cross-entity whereBetween", () => {
    it("should resolve alias.property in whereBetween", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.whereBetween("au.age", 18, 65);
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`age` BETWEEN");
      expect(values).toContain(18);
      expect(values).toContain(65);
    });
  });

  describe("cross-entity whereLike", () => {
    it("should resolve alias.property in whereLike", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.whereLike("au.firstName", "%J%");
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`firstName` LIKE ?");
      expect(values).toContain("%J%");
    });
  });

  // ── Cross-entity SELECT ──

  describe("selectRaw — cross-entity columns", () => {
    it("should resolve alias.property in selectRaw", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.selectRaw(["a.title", "au.firstName"]);
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`title`");
      expect(text).toContain("`au`.`firstName`");
      expect(text).not.toContain("`a`.*");
    });
  });

  describe("addSelect — cross-entity string", () => {
    it("should resolve alias.property in addSelect with string", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.addSelect("au.firstName", "authorName");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`firstName` AS `authorName`");
    });
  });

  // ── Cross-entity ORDER BY ──

  describe("addOrderBy — cross-entity", () => {
    it("should resolve alias.property in addOrderBy", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.addOrderBy("au.firstName", "ASC");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`firstName` ASC");
    });
  });

  // ── Cross-entity GROUP BY ──

  describe("groupBy — cross-entity", () => {
    it("should resolve alias.property in groupBy", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.groupBy(["au.firstName"] as any);
      const { text } = qb.getSql();

      expect(text).toContain("GROUP BY `au`.`firstName`");
    });
  });

  // ── Subquery ──

  describe("subquery with entity builder", () => {
    it("should compose subquery as WHERE IN value", () => {
      const em = createMockEm("mysql");
      const resolverRef = (em as any).resolver as RelationMetadataResolver;

      // Create inner subquery
      const inner = new SelectQueryBuilder<Author>(Author as any, "au", em);
      const meta = resolverRef.resolveEntityMetadata(Author as any);
      if (meta) {
        const map = new Map<string, string>();
        for (const col of meta.columns) {
          const prop = (col as any).propertyKey ?? col.name!;
          map.set(prop, col.name!);
        }
        inner.setPropertyToColumnMap(map);
      }
      inner.select(["id"]);
      inner.where("age", ">=", 18);
      const innerSql = inner.toSql();

      // Create outer query
      const outer = new SelectQueryBuilder<Article>(Article as any, "a", em);
      const articleMeta = resolverRef.resolveEntityMetadata(Article as any);
      if (articleMeta) {
        const map = new Map<string, string>();
        for (const col of articleMeta.columns) {
          const prop = (col as any).propertyKey ?? col.name!;
          map.set(prop, col.name!);
        }
        outer.setPropertyToColumnMap(map);
      }

      // Use subquery as raw Sql in WHERE
      outer.where(Conditions.in("`a`.`authorId`", [innerSql]));
      const { text } = outer.getSql();

      expect(text).toContain("`a`.*");
      expect(text).toContain("FROM `article` AS `a`");
      expect(text).toContain("IN");
    });
  });

  // ── Backward Compatibility ──

  describe("backward compat — string-based leftJoin", () => {
    it("should still accept raw table name and string condition", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin("author", "au", "`a`.`authorId` = `au`.`id`");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("`a`.`authorId` = `au`.`id`");
    });

    it("should still accept raw table name with Sql condition", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoin(
        "author",
        "au",
        Conditions.compareColumns("`a`.`authorId`", "=", "`au`.`id`"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
    });
  });

  describe("backward compat — plain property where", () => {
    it("should still resolve plain property names against main entity", () => {
      const { qb } = createQb(Article, "a");
      qb.where("title", "Hello");
      const { text, values } = qb.getSql();

      expect(text).toContain("`a`.`title` = ?");
      expect(values).toContain("Hello");
    });
  });

  // ── PostgreSQL Dialect ──

  describe("PostgreSQL dialect", () => {
    it("should use double-quote wrapping for entity joins", () => {
      const { qb } = createQb(Article, "a", "postgresql");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.where("au.firstName", "LIKE", "%John%");
      const { text } = qb.getSql();

      expect(text).toContain('LEFT JOIN "author" AS "au"');
      expect(text).toContain('"a"."authorId" = "au"."id"');
      expect(text).toContain('"au"."firstName" LIKE');
    });

    it("should use double-quote wrapping for cross-entity SELECT", () => {
      const { qb } = createQb(Article, "a", "postgresql");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      qb.selectRaw(["a.title", "au.firstName"]);
      const { text } = qb.getSql();

      expect(text).toContain('"a"."title"');
      expect(text).toContain('"au"."firstName"');
    });
  });

  // ── JoinOnBuilder standalone ──

  describe("JoinOnBuilder", () => {
    it("should throw when build() is called with no conditions", () => {
      const builder = new JoinOnBuilder((ref) => ref);
      expect(() => builder.build()).toThrow(/JOIN ON condition is empty/);
    });
  });

  // ── Complex scenario: join + where + select + order ──

  describe("complex query — join + where + select + order", () => {
    it("should combine all features in a single query (MySQL)", () => {
      const { qb } = createQb(Article, "a");

      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"))
        .leftJoin(Comment, "c", (j) => j.on("c.articleId", "=", "a.id"))
        .selectRaw(["a.title", "au.firstName", "c.content"])
        .where("a.status", "published")
        .where("au.age", ">=", 18)
        .whereNotNull("c.content")
        .addOrderBy("au.firstName", "ASC")
        .addOrderBy("a.title", "DESC")
        .limit(10)
        .offset(0);

      const { text, values } = qb.getSql();

      expect(text).toContain("`a`.`title`");
      expect(text).toContain("`au`.`firstName`");
      expect(text).toContain("`c`.`content`");
      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("LEFT JOIN `comment` AS `c`");
      expect(text).toContain("`a`.`status` = ?");
      expect(text).toContain("`au`.`age` >= ?");
      expect(text).toContain("`c`.`content` IS NOT NULL");
      expect(text).toContain("ORDER BY");
      expect(text).toContain("`au`.`firstName` ASC");
      expect(text).toContain("`a`.`title` DESC");
      expect(values).toContain("published");
      expect(values).toContain(18);
    });
  });

  // ── SnakeNamingStrategy ──

  describe("SnakeNamingStrategy — cross-entity resolution", () => {
    function createSnakeQb<T>(
      entity: new () => T,
      alias: string,
      dbType: "mysql" | "postgresql" = "mysql",
    ) {
      const em = createMockEm(dbType);
      const qb = new SelectQueryBuilder<T>(entity as any, alias, em);
      const resolver = (em as any).resolver as RelationMetadataResolver;
      const ns = new SnakeNamingStrategy();

      const meta = resolver.resolveEntityMetadata(entity as any);
      if (meta) {
        // Apply SnakeNamingStrategy: transform column names
        const map = new Map<string, string>();
        for (const col of meta.columns) {
          const prop = (col as any).propertyKey ?? col.name!;
          const dbCol = (col as any).nameExplicit ? col.name! : ns.columnName(prop);
          map.set(prop, dbCol);
        }
        qb.setPropertyToColumnMap(map);
      }
      return { qb, em };
    }

    it("should convert camelCase properties to snake_case in entity JOIN", () => {
      const { qb } = createSnakeQb(Article, "a");

      // Manually register Author with snake_case mapping
      const resolver = ((qb as any).em as any).resolver as RelationMetadataResolver;
      const authorMeta = resolver.resolveEntityMetadata(Author as any);
      const ns = new SnakeNamingStrategy();
      if (authorMeta) {
        const map = new Map<string, string>();
        for (const col of authorMeta.columns) {
          const prop = (col as any).propertyKey ?? col.name!;
          const dbCol = (col as any).nameExplicit ? col.name! : ns.columnName(prop);
          map.set(prop, dbCol);
        }
        (qb as any).aliasRegistry.set("au", {
          entity: Author,
          tableName: authorMeta.name!,
          propertyToColumnMap: map,
        });
      }

      // Now cross-entity WHERE should use snake_case
      qb.where("au.firstName", "LIKE", "%John%");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`first_name` LIKE ?");
    });

    it("should convert main entity properties to snake_case", () => {
      const { qb } = createSnakeQb(Article, "a");
      qb.where("authorId", "=", 1);
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`author_id` = ?");
    });

    it("should convert entity-aware JOIN ON conditions to snake_case", () => {
      const { qb, em } = createSnakeQb(Article, "a");

      // Override the entity join to also apply snake naming
      const resolver = (em as any).resolver as RelationMetadataResolver;
      const authorMeta = resolver.resolveEntityMetadata(Author as any);
      const ns = new SnakeNamingStrategy();
      if (authorMeta) {
        const map = new Map<string, string>();
        for (const col of authorMeta.columns) {
          const prop = (col as any).propertyKey ?? col.name!;
          const dbCol = (col as any).nameExplicit ? col.name! : ns.columnName(prop);
          map.set(prop, dbCol);
        }
        // Pre-register alias so resolveColumn works during join builder
        (qb as any).aliasRegistry.set("au", {
          entity: Author,
          tableName: authorMeta.name!,
          propertyToColumnMap: map,
        });
      }

      // Use entity-aware join (but with pre-registered alias for snake mapping)
      qb.leftJoin("author", "au",
        Conditions.compareColumns("`a`.`author_id`", "=", "`au`.`id`"),
      );
      qb.selectRaw(["a.title", "au.firstName"]);
      qb.addOrderBy("au.lastName", "DESC");
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`title`");
      expect(text).toContain("`au`.`first_name`");
      expect(text).toContain("`au`.`last_name` DESC");
    });
  });

  // ── leftJoinAndSelect / innerJoinAndSelect ──

  describe("leftJoinAndSelect", () => {
    it("should join and auto-select all columns from joined entity", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoinAndSelect(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      // #370: Main entity `*` is expanded into alias-prefixed columns so
      // joined columns can never clobber root columns in the row object
      expect(text).toContain("`a`.`id` AS `a_id`");
      expect(text).toContain("`a`.`title` AS `a_title`");
      // Joined entity columns are selected with alias prefixes
      expect(text).toContain("`au`.`id` AS `au_id`");
      expect(text).toContain("`au`.`firstName` AS `au_firstName`");
      expect(text).toContain("`au`.`lastName` AS `au_lastName`");
      expect(text).toContain("`au`.`age` AS `au_age`");
      // JOIN itself
      expect(text).toContain("LEFT JOIN `author` AS `au`");
    });

    it("should work with explicit select on main entity", () => {
      const { qb } = createQb(Article, "a");
      qb.select(["id", "title"]);
      qb.leftJoinAndSelect(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      // Main entity has specific columns
      expect(text).toContain("`a`.`id`");
      expect(text).toContain("`a`.`title`");
      // Joined entity columns appended
      expect(text).toContain("`au`.`firstName`");
    });
  });

  describe("innerJoinAndSelect", () => {
    it("should generate INNER JOIN and auto-select", () => {
      const { qb } = createQb(Article, "a");
      qb.innerJoinAndSelect(Author, "au", (j) =>
        j.on("a.authorId", "=", "au.id"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN `author` AS `au`");
      expect(text).toContain("`au`.`firstName`");
    });
  });

  describe("leftJoinRelationAndSelect", () => {
    it("should auto-join from relation and auto-select", () => {
      const { qb } = createQb(Article, "a");
      qb.leftJoinRelationAndSelect("author", "au");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("`au`.`id`");
      expect(text).toContain("`au`.`firstName`");
      expect(text).toContain("`au`.`lastName`");
      expect(text).toContain("`au`.`age`");
    });
  });

  describe("innerJoinRelationAndSelect", () => {
    it("should auto-join from relation and auto-select with INNER", () => {
      const { qb } = createQb(Article, "a");
      qb.innerJoinRelationAndSelect("author", "au");
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN `author` AS `au`");
      expect(text).toContain("`au`.`firstName`");
    });
  });

  // ── alias() helper ──

  describe("alias() — typed entity reference", () => {
    it("should return alias.property strings", () => {
      const u = alias(Author, "u");
      expect(u.col("firstName")).toBe("u.firstName");
      expect(u.col("age")).toBe("u.age");
      expect(u._alias).toBe("u");
    });

    it("should work with where() for cross-entity autocomplete", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.where(au.col("firstName"), "LIKE", "%John%");
      qb.where(a.col("status"), "published");
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`firstName` LIKE ?");
      expect(text).toContain("`a`.`status` = ?");
      expect(values).toContain("%John%");
      expect(values).toContain("published");
    });

    it("should work with selectRaw for cross-entity projection", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.selectRaw([a.col("title"), au.col("firstName")]);
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`title`");
      expect(text).toContain("`au`.`firstName`");
    });

    it("should work with addOrderBy", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.addOrderBy(au.col("lastName"), "DESC");
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`lastName` DESC");
    });

    it("should work with whereIn, whereNull, whereBetween", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.whereIn(au.col("id"), [1, 2, 3]);
      qb.whereNotNull(au.col("firstName"));
      qb.whereBetween(au.col("age"), 18, 65);
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`id` IN");
      expect(text).toContain("`au`.`firstName` IS NOT NULL");
      expect(text).toContain("`au`.`age` BETWEEN");
    });

    it("should work with groupBy", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.groupBy([au.col("firstName")] as any);
      const { text } = qb.getSql();

      expect(text).toContain("GROUP BY `au`.`firstName`");
    });
  });

  // ── qAlias() — QueryDSL-style expressions ──

  describe("qAlias() — QueryDSL-style expressions", () => {
    it("should expose entity properties as ColumnExpression", () => {
      const u = qAlias(Author, "u");
      expect(u._alias).toBe("u");
      expect(u.col("firstName")).toBe("u.firstName");
      // Property access returns ColumnExpression
      const expr = u.firstName;
      expect(expr.toString()).toBe("u.firstName");
    });

    it("u.firstName.eq('Alice') should resolve in where()", () => {
      const a = qAlias(Article, "a");
      const au = qAlias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.where(au.firstName.eq("Alice"));
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`firstName` = ?");
      expect(values).toContain("Alice");
    });

    it("u.age.gte(18) should resolve in where()", () => {
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", au.col("id")),
      );
      qb.where(au.age.gte(18));
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`age` >= ?");
      expect(values).toContain(18);
    });

    it("u.name.like('%John%') should generate LIKE", () => {
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", au.col("id")),
      );
      qb.where(au.firstName.like("%John%"));
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`firstName` LIKE ?");
      expect(values).toContain("%John%");
    });

    it("u.id.in([1,2,3]) should generate IN", () => {
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", au.col("id")),
      );
      qb.where(au.id.in([1, 2, 3]));
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`id` IN");
      expect(values).toEqual([1, 2, 3]);
    });

    it("u.deletedAt.isNull() should generate IS NULL", () => {
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", au.col("id")),
      );
      qb.where(au.firstName.isNull());
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`firstName` IS NULL");
    });

    it("u.age.between(18, 65) should generate BETWEEN", () => {
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", au.col("id")),
      );
      qb.where(au.age.between(18, 65));
      const { text, values } = qb.getSql();

      expect(text).toContain("`au`.`age` BETWEEN");
      expect(values).toContain(18);
      expect(values).toContain(65);
    });

    it("should work with andWhere and orWhere", () => {
      const a = qAlias(Article, "a");
      const au = qAlias(Author, "au");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      );
      qb.where(a.status.eq("published"));
      qb.andWhere(au.age.gte(18));
      qb.orWhere(au.firstName.eq("Admin"));
      const { text } = qb.getSql();

      expect(text).toContain("`a`.`status` = ?");
      expect(text).toContain("`au`.`age` >= ?");
      expect(text).toContain("`au`.`firstName` = ?");
      expect(text).toContain("OR");
    });

    it("neq, gt, lt, lte, notLike, notIn, isNotNull should all work", () => {
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on("a.authorId", "=", au.col("id")),
      );

      // Test each operator individually
      qb.where(au.age.neq(0));
      qb.andWhere(au.age.gt(10));
      qb.andWhere(au.age.lt(100));
      qb.andWhere(au.age.lte(99));
      qb.andWhere(au.firstName.notLike("%bot%"));
      qb.andWhere(au.id.notIn([999]));
      qb.andWhere(au.lastName.isNotNull());
      const { text } = qb.getSql();

      expect(text).toContain("`au`.`age` != ?");
      expect(text).toContain("`au`.`age` > ?");
      expect(text).toContain("`au`.`age` < ?");
      expect(text).toContain("`au`.`age` <= ?");
      expect(text).toContain("`au`.`firstName` NOT LIKE ?");
      expect(text).toContain("`au`.`id` NOT IN");
      expect(text).toContain("`au`.`lastName` IS NOT NULL");
    });

    it("complex query: join + qAlias expressions + order", () => {
      const a = qAlias(Article, "a");
      const au = qAlias(Author, "au");
      const c = qAlias(Comment, "c");

      const { qb } = createQb(Article, "a");
      qb.leftJoin(Author, "au", (j) =>
        j.on(a.col("authorId"), "=", au.col("id")),
      )
        .leftJoin(Comment, "c", (j) =>
          j.on(c.col("articleId"), "=", a.col("id")),
        )
        .where(a.status.eq("published"))
        .where(au.age.gte(18))
        .where(c.content.isNotNull())
        .limit(10);

      const { text, values } = qb.getSql();

      expect(text).toContain("`a`.`status` = ?");
      expect(text).toContain("`au`.`age` >= ?");
      expect(text).toContain("`c`.`content` IS NOT NULL");
      expect(values).toContain("published");
      expect(values).toContain(18);
    });
  });

  // ── EntityRef overload tests (#238) ──

  describe("isEntityRef type guard", () => {
    it("should return true for alias()", () => {
      const ref = alias(Author, "au");
      expect(isEntityRef(ref)).toBe(true);
    });

    it("should return true for qAlias()", () => {
      const ref = qAlias(Author, "au");
      expect(isEntityRef(ref)).toBe(true);
    });

    it("should return false for plain objects", () => {
      expect(isEntityRef(null)).toBe(false);
      expect(isEntityRef(undefined)).toBe(false);
      expect(isEntityRef("author")).toBe(false);
      expect(isEntityRef(Author)).toBe(false);
      expect(isEntityRef({ _alias: "au" })).toBe(false);
    });
  });

  describe("EntityRef overload — leftJoin(ref, onBuilder)", () => {
    it("should accept alias() directly (MySQL)", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");
      const { qb } = createQb(Article, "a", "mysql");

      qb.leftJoin(au, (j) => j.on(a.col("authorId"), "=", au.col("id")));
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("`a`.`authorId` = `au`.`id`");
    });

    it("should accept qAlias() directly (PostgreSQL)", () => {
      const a = qAlias(Article, "a");
      const au = qAlias(Author, "au");
      const { qb } = createQb(Article, "a", "postgresql");

      qb.leftJoin(au, (j) => j.on(a.col("authorId"), "=", au.col("id")));
      const { text } = qb.getSql();

      expect(text).toContain('LEFT JOIN "author" AS "au"');
      expect(text).toContain('"a"."authorId" = "au"."id"');
    });
  });

  describe("EntityRef overload — innerJoin(ref, onBuilder)", () => {
    it("should accept alias() directly (MySQL)", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");
      const { qb } = createQb(Article, "a", "mysql");

      qb.innerJoin(au, (j) => j.on(a.col("authorId"), "=", au.col("id")));
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN `author` AS `au`");
    });
  });

  describe("EntityRef overload — rightJoin(ref, onBuilder)", () => {
    it("should accept alias() directly (MySQL)", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");
      const { qb } = createQb(Article, "a", "mysql");

      qb.rightJoin(au, (j) => j.on(a.col("authorId"), "=", au.col("id")));
      const { text } = qb.getSql();

      expect(text).toContain("RIGHT JOIN `author` AS `au`");
    });
  });

  describe("EntityRef overload — leftJoinAndSelect(ref, onBuilder)", () => {
    it("should accept alias() and auto-select joined columns", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");
      const { qb } = createQb(Article, "a", "mysql");

      qb.leftJoinAndSelect(au, (j) => j.on(a.col("authorId"), "=", au.col("id")));
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN `author` AS `au`");
      // leftJoinAndSelect should add au.* columns to SELECT
      expect(text).toContain("`au`.");
    });
  });

  describe("EntityRef overload — innerJoinAndSelect(ref, onBuilder)", () => {
    it("should accept alias() and auto-select joined columns", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");
      const { qb } = createQb(Article, "a", "mysql");

      qb.innerJoinAndSelect(au, (j) => j.on(a.col("authorId"), "=", au.col("id")));
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN `author` AS `au`");
      expect(text).toContain("`au`.");
    });
  });

  describe("EntityRef overload — backward compatibility", () => {
    it("existing (entity, alias, builder) syntax still works", () => {
      const { qb } = createQb(Article, "a", "mysql");
      qb.leftJoin(Author, "au", (j) => j.on("a.authorId", "=", "au.id"));
      const { text } = qb.getSql();
      expect(text).toContain("LEFT JOIN `author` AS `au`");
    });

    it("existing string-based syntax still works", () => {
      const { qb } = createQb(Article, "a", "mysql");
      qb.leftJoin("users", "u", "`a`.`author_id` = `u`.`id`");
      const { text } = qb.getSql();
      expect(text).toContain("LEFT JOIN `users` AS `u`");
    });
  });

  describe("EntityRef overload — chained multi-join", () => {
    it("should chain multiple EntityRef joins", () => {
      const a = alias(Article, "a");
      const au = alias(Author, "au");
      const c = alias(Comment, "c");
      const { qb } = createQb(Article, "a", "mysql");

      qb.leftJoin(au, (j) => j.on(a.col("authorId"), "=", au.col("id")))
        .innerJoin(c, (j) => j.on(c.col("articleId"), "=", a.col("id")));

      const { text } = qb.getSql();
      expect(text).toContain("LEFT JOIN `author` AS `au`");
      expect(text).toContain("INNER JOIN `comment` AS `c`");
    });
  });
});
