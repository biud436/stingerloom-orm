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
