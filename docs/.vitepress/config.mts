import { defineConfig } from "vitepress";

// ─────────────────────────────────────────────────
// Shared sidebar (reused across locales)
// ─────────────────────────────────────────────────

function sidebarEn() {
  return [
    {
      text: "Introduction",
      items: [
        { text: "Getting Started", link: "/getting-started" },
        { text: "Configuration", link: "/configuration" },
      ],
    },
    {
      text: "Essentials",
      items: [
        { text: "Entities & Columns", link: "/entities" },
        { text: "Relations", link: "/relations" },
        { text: "Transactions", link: "/transactions" },
      ],
    },
    {
      text: "Entity Manager",
      collapsed: false,
      items: [
        { text: "CRUD Basics", link: "/entity-manager" },
        { text: "Querying & Pagination", link: "/entity-manager-querying" },
        { text: "Writes & Transactions", link: "/entity-manager-writes" },
        { text: "Advanced", link: "/entity-manager-advanced" },
      ],
    },
    {
      text: "Querying",
      collapsed: true,
      items: [
        { text: "Query Builder", link: "/query-builder" },
        { text: "Raw SQL & CTE", link: "/raw-sql" },
        { text: "Pagination & Streaming", link: "/pagination" },
      ],
    },
    {
      text: "Schema & Migrations",
      collapsed: true,
      items: [
        { text: "Migrations", link: "/migrations" },
        { text: "Migration CLI", link: "/cli" },
      ],
    },
    {
      text: "Advanced",
      collapsed: false,
      items: [
        { text: "Multi-Tenancy", link: "/multi-tenancy" },
        { text: "Events & Subscribers", link: "/events" },
        { text: "Logging & Diagnostics", link: "/logging" },
        { text: "Plugins", link: "/plugins" },
      ],
    },
    {
      text: "Write Buffer",
      collapsed: false,
      items: [
        { text: "Basics", link: "/write-buffer" },
        { text: "Advanced Patterns", link: "/write-buffer-advanced" },
      ],
    },
    {
      text: "Integration",
      collapsed: true,
      items: [{ text: "NestJS", link: "/nestjs" }],
    },
    {
      text: "Tutorials",
      collapsed: false,
      items: [
        { text: "IoT Smart Thermometer", link: "/tutorial-iot" },
      ],
    },
    {
      text: "Reference",
      collapsed: true,
      items: [
        { text: "API Reference", link: "/api-reference" },
        { text: "Architecture", link: "/architecture" },
        { text: "Production Guide", link: "/production-guide" },
        { text: "Contributor Guide", link: "/onboarding" },
      ],
    },
  ];
}

function sidebarKo() {
  return [
    {
      text: "소개",
      items: [
        { text: "시작하기", link: "/ko/getting-started" },
        { text: "설정", link: "/ko/configuration" },
      ],
    },
    {
      text: "기본 개념",
      items: [
        { text: "엔티티 & 컬럼", link: "/ko/entities" },
        { text: "관계", link: "/ko/relations" },
        { text: "트랜잭션", link: "/ko/transactions" },
      ],
    },
    {
      text: "엔티티 매니저",
      collapsed: false,
      items: [
        { text: "CRUD 기본", link: "/ko/entity-manager" },
        { text: "쿼리 & 페이지네이션", link: "/ko/entity-manager-querying" },
        { text: "쓰기 & 트랜잭션", link: "/ko/entity-manager-writes" },
        { text: "고급 기능", link: "/ko/entity-manager-advanced" },
      ],
    },
    {
      text: "쿼리",
      collapsed: true,
      items: [
        { text: "쿼리 빌더", link: "/ko/query-builder" },
        { text: "Raw SQL & CTE", link: "/ko/raw-sql" },
        { text: "페이지네이션 & 스트리밍", link: "/ko/pagination" },
      ],
    },
    {
      text: "스키마 & 마이그레이션",
      collapsed: true,
      items: [
        { text: "마이그레이션", link: "/ko/migrations" },
        { text: "마이그레이션 CLI", link: "/ko/cli" },
      ],
    },
    {
      text: "고급",
      collapsed: false,
      items: [
        { text: "멀티테넌시", link: "/ko/multi-tenancy" },
        { text: "이벤트 & 구독자", link: "/ko/events" },
        { text: "로깅 & 진단", link: "/ko/logging" },
        { text: "플러그인", link: "/ko/plugins" },
      ],
    },
    {
      text: "Write Buffer",
      collapsed: false,
      items: [
        { text: "기본", link: "/ko/write-buffer" },
        { text: "고급 패턴", link: "/ko/write-buffer-advanced" },
      ],
    },
    {
      text: "통합",
      collapsed: true,
      items: [{ text: "NestJS", link: "/ko/nestjs" }],
    },
    {
      text: "튜토리얼",
      collapsed: false,
      items: [
        { text: "IoT 스마트 온도계", link: "/ko/tutorial-iot" },
      ],
    },
    {
      text: "레퍼런스",
      collapsed: true,
      items: [
        { text: "API 레퍼런스", link: "/ko/api-reference" },
        { text: "아키텍처", link: "/ko/architecture" },
        { text: "프로덕션 가이드", link: "/ko/production-guide" },
        { text: "기여자 가이드", link: "/ko/onboarding" },
      ],
    },
  ];
}

// ─────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────

export default defineConfig({
  title: "Stingerloom ORM",
  description:
    "A standalone, framework-agnostic TypeScript ORM with multi-tenancy support",
  base: "/stingerloom-orm/",
  ignoreDeadLinks: true,

  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: "/stingerloom-orm/logo.svg" },
    ],
  ],

  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/getting-started" },
          {
            text: "Querying",
            items: [
              { text: "Query Builder", link: "/query-builder" },
              { text: "Raw SQL & CTE", link: "/raw-sql" },
              { text: "Pagination & Streaming", link: "/pagination" },
            ],
          },
          {
            text: "Integration",
            items: [{ text: "NestJS", link: "/nestjs" }],
          },
          { text: "Tutorials", link: "/tutorial-iot" },
          { text: "API Reference", link: "/api-reference" },
          {
            text: "GitHub",
            link: "https://github.com/biud436/stingerloom-orm",
          },
        ],
        sidebar: sidebarEn(),
      },
    },
    ko: {
      label: "한국어",
      lang: "ko",
      themeConfig: {
        nav: [
          { text: "가이드", link: "/ko/getting-started" },
          {
            text: "쿼리",
            items: [
              { text: "쿼리 빌더", link: "/ko/query-builder" },
              { text: "Raw SQL & CTE", link: "/ko/raw-sql" },
              { text: "페이지네이션 & 스트리밍", link: "/ko/pagination" },
            ],
          },
          {
            text: "통합",
            items: [{ text: "NestJS", link: "/ko/nestjs" }],
          },
          { text: "튜토리얼", link: "/ko/tutorial-iot" },
          { text: "API 레퍼런스", link: "/ko/api-reference" },
          {
            text: "GitHub",
            link: "https://github.com/biud436/stingerloom-orm",
          },
        ],
        sidebar: sidebarKo(),
        outline: {
          label: "목차",
        },
        docFooter: {
          prev: "이전",
          next: "다음",
        },
        lastUpdated: {
          text: "최근 수정",
        },
        returnToTopLabel: "맨 위로",
        sidebarMenuLabel: "메뉴",
        darkModeSwitchLabel: "다크 모드",
      },
    },
  },

  themeConfig: {
    logo: "/logo.svg",

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 biud436",
    },

    search: {
      provider: "local",
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/biud436/stingerloom-orm" },
    ],
  },
});
