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
      { text: "API Reference", link: "/api-reference" },
      {
        text: "GitHub",
        link: "https://github.com/biud436/stingerloom-orm",
      },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/getting-started" },
          { text: "Entities", link: "/entities" },
          { text: "Relations", link: "/relations" },
          { text: "EntityManager", link: "/entity-manager" },
          { text: "Query Builder", link: "/query-builder" },
          { text: "Transactions", link: "/transactions" },
          { text: "Migrations", link: "/migrations" },
          { text: "Configuration", link: "/configuration" },
          { text: "Prisma Import", link: "/prisma-import" },
        ],
      },
      {
        text: "Advanced",
        items: [
          { text: "Advanced Features", link: "/advanced" },
          { text: "Multi-Tenancy", link: "/multi-tenancy" },
          { text: "Production Guide", link: "/production-guide" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "API Reference", link: "/api-reference" },
          { text: "Contributor Onboarding", link: "/onboarding" },
          { text: "Manual Testing Guide", link: "/manual-testing-guide" },
          { text: "Pre-Release Checklist", link: "/pre-release-checklist" },
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
