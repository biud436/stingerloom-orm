import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Stingerloom ORM",
  description:
    "A standalone, framework-agnostic TypeScript ORM with multi-tenancy support",
  base: "/stingerloom-orm/",

  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: "/stingerloom-orm/logo.svg" },
    ],
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
          // { text: "Database Seeding", link: "/seeding" },
          // { text: "Database Introspection", link: "/introspection" },
          // { text: "Prisma Import", link: "/prisma-import" },
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
