import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Stingerloom ORM",
  description:
    "A standalone, framework-agnostic TypeScript ORM with multi-tenancy support",
  base: "/stingerloom-orm/",

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/stingerloom-orm/logo.svg" }],
  ],

  themeConfig: {
    logo: "/logo.svg",
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
      { text: "NestJS", link: "/nestjs" },
      { text: "API Reference", link: "/api-reference" },
      {
        text: "GitHub",
        link: "https://github.com/biud436/stingerloom-orm",
      },
    ],

    sidebar: [
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
          { text: "Database Seeding", link: "/seeding" },
          { text: "Database Introspection", link: "/introspection" },
          { text: "Prisma Import", link: "/prisma-import" },
        ],
      },
      {
        text: "Advanced",
        collapsed: false,
        items: [
          { text: "Multi-Tenancy", link: "/multi-tenancy" },
          { text: "Events & Subscribers", link: "/events" },
          { text: "Logging & Diagnostics", link: "/logging" },
        ],
      },
      {
        text: "Plugins",
        collapsed: false,
        items: [
          { text: "Plugin System", link: "/plugins" },
          { text: "Write Buffer — Basics", link: "/write-buffer" },
          { text: "Write Buffer — Advanced", link: "/write-buffer-advanced" },
        ],
      },
      {
        text: "NestJS Integration",
        collapsed: true,
        items: [
          { text: "Module Setup", link: "/nestjs" },
        ],
      },
      {
        text: "Deployment",
        collapsed: true,
        items: [
          { text: "Production Guide", link: "/production-guide" },
          { text: "Pre-Release Checklist", link: "/pre-release-checklist" },
        ],
      },
      {
        text: "Reference",
        collapsed: true,
        items: [
          { text: "API Reference", link: "/api-reference" },
          { text: "Architecture", link: "/architecture" },
          { text: "Contributor Guide", link: "/onboarding" },
        ],
      },
    ],

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
