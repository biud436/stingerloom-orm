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

  // Transform TypeScript files
  transform: {
    "^.+\\.ts$": "ts-jest",
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
  setupFilesAfterEnv: [],

  // Coverage configuration
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/index.ts",
  ],
};
