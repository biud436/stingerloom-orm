module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",

  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },

  // Coverage ignore patterns
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "/__tests__/",
    "/examples/",
  ],

  // Module file extensions
  moduleFileExtensions: ["js", "ts", "json", "node"],

  // Transform TypeScript files. Point ts-jest at __tests__/tsconfig.json
  // so jest globals (`describe`, `it`, `expect`, etc.) resolve via the
  // `types: ["jest", "node"]` declared there. The root tsconfig only
  // includes src/**/* — TS 6 stopped auto-loading every @types package
  // when the include glob excludes the test directory.
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      { tsconfig: "<rootDir>/__tests__/tsconfig.json" },
    ],
  },

  // Module name mapper for absolute imports
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },

  // Test file patterns
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.spec.ts",
    "**/*.test.ts",
    "**/*.spec.ts",
  ],

  // Files to ignore — integration tests require INTEGRATION_TEST=true
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    ...(process.env.INTEGRATION_TEST === "true" ? [] : ["/__tests__/integration/"]),
  ],
  transformIgnorePatterns: ["<rootDir>/node_modules/"],

  // Setup files
  setupFiles: ["reflect-metadata"],
  setupFilesAfterEnv: [],

  // Coverage configuration
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/index.ts",
  ],
};
