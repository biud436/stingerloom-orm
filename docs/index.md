---
layout: home

hero:
  name: Stingerloom ORM
  text: TypeScript ORM for Node.js
  tagline: Framework-agnostic ORM with multi-tenancy, MySQL, PostgreSQL & SQLite support
  actions:
    - theme: brand
      text: Getting Started
      link: /getting-started
    - theme: alt
      text: API Reference
      link: /api-reference
    - theme: alt
      text: GitHub
      link: https://github.com/biud436/stingerloom-orm

features:
  - title: Full CRUD & Relations
    details: ManyToOne, OneToMany, ManyToMany, OneToOne with eager/lazy loading, cascades, and soft delete support.
  - title: Multi-Tenancy
    details: Docker OverlayFS-inspired layered metadata system with AsyncLocalStorage for safe concurrent tenant isolation.
  - title: Type-Safe TypeScript
    details: Decorator-based entity definitions, generic query builder, and strict type checking throughout.
  - title: Multi-Dialect
    details: MySQL, PostgreSQL, and SQLite drivers with parameterized queries and SQL injection prevention.
  - title: Schema Migrations
    details: Automatic schema diff detection, migration generation, and tenant-aware migration runner.
  - title: NestJS Integration
    details: First-class NestJS support with @InjectRepository, @Transactional, and dedicated module.
---
