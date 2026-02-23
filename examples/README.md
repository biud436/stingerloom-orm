# Stingerloom ORM Examples

This directory contains example projects demonstrating how to use Stingerloom ORM with different frameworks and use cases.

## Available Examples

### 🐱 [NestJS Cats API](./nestjs-cats)

A complete CRUD API built with NestJS demonstrating:

- **DatabaseModule.forRoot()** pattern following the original Stingerloom framework
- Entity definitions with decorators (`@Entity`, `@Column`, `@PrimaryGeneratedColumn`)
- Repository pattern for database operations
- Metadata-based configuration storage
- NestJS lifecycle hooks integration (`OnModuleInit`, `OnModuleDestroy`)
- Environment variable configuration with `@nestjs/config`

**Tech Stack**: NestJS, TypeScript, MySQL, Stingerloom ORM

**Quick Start**:

```bash
cd nestjs-cats
npm install
npm run build
npm run start:dev
```

---

### 📝 [NestJS Blog API](./nestjs-blog)

Advanced blog API demonstrating features not covered in nestjs-cats:

- **`@ManyToMany`** — Post ↔ Tag 다대다 관계 (중간 테이블 자동 생성)
- **`findAndCount()`** — 페이지네이션 with total count (`GET /posts/paginated`)
- **`upsert()`** — slug/name 기준 INSERT ON CONFLICT (`POST /posts/upsert`, `POST /tags/upsert`)
- **`explain()`** — 쿼리 실행 계획 조회 (`GET /posts/:id/explain`)
- **`SchemaDiff`** — 엔티티 vs DB 스키마 비교 (`GET /posts/schema-diff`)
- **`SchemaDiffMigrationGenerator`** — Migration 파일 자동 생성 (`POST /posts/schema-diff/generate`)
- **`findWithCursor()`** — 커서 기반 페이지네이션 (`GET /posts/cursor`)
- **`@UniqueIndex`** — User.email, User.username, Post.slug, Tag.name 복합 유니크 인덱스
- **`@DeletedAt` + `@Version`** — Soft Delete + Optimistic Locking
- **4개 엔티티**: User, Post, Tag, Category (OneToMany, ManyToOne, ManyToMany 관계)

**Endpoints**:
| Method | Path | 기능 |
|--------|------|------|
| GET | /posts/paginated?page=1&limit=10 | findAndCount 페이지네이션 |
| GET | /posts/cursor?take=10&cursor=xxx | 커서 페이지네이션 |
| POST | /posts/upsert | slug 기준 upsert |
| GET | /posts/:id/explain | 쿼리 실행 계획 |
| GET | /posts/schema-diff | 스키마 diff |
| POST | /posts/schema-diff/generate | Migration 파일 생성 |
| POST | /tags/upsert | name 기준 태그 upsert |
| GET | /tags/paginated | 태그 페이지네이션 |
| GET | /users/paginated | 사용자 페이지네이션 |

**Tech Stack**: NestJS, TypeScript, MySQL, Stingerloom ORM

**Quick Start**:

```bash
cd nestjs-blog
pnpm install
pnpm build
pnpm start:dev
```
