# Stingerloom MCP Servers

Claude Code에서 로컬 데이터베이스에 직접 접근하기 위한 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 서버입니다.

## 서버 목록

| 파일 | DB | 기본 포트 | 제공 도구 |
|------|-----|----------|----------|
| `mysql-server.ts` | MySQL / MariaDB | 3306 | `query`, `list_tables`, `describe_table`, `list_databases` |
| `postgres-server.ts` | PostgreSQL | 5432 | `query`, `list_tables`, `describe_table`, `list_schemas`, `list_databases` |

## 사용법

Claude Code의 `.mcp.json`에 서버를 등록하면, 대화 중 SQL 쿼리 실행, 테이블 조회, 스키마 탐색 등을 자연어로 요청할 수 있습니다.

## 환경 변수

| 변수 | 설명 | 기본값 (MySQL) | 기본값 (PostgreSQL) |
|------|------|---------------|-------------------|
| `DB_HOST` | 호스트 | `localhost` | `localhost` |
| `DB_PORT` | 포트 | `3306` | `5432` |
| `DB_NAME` | 데이터베이스명 | `fastify` | `multi_tenancy_db2` |
| `DB_USER` | 사용자 | `admin` | `postgres` |
| `DB_PASSWORD` | 비밀번호 | — | — |
| `MYSQL_PWD` | MySQL 비밀번호 (우선) | — | — |
| `PGPASSWORD` | PostgreSQL 비밀번호 (우선) | — | — |
