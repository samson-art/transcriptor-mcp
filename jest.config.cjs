module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // ui/: the widgets' pure helpers in ui/shared (no React) and the bundle check that the build runs.
  roots: ['<rootDir>/src', '<rootDir>/ui'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/mcp.ts', // Exclude MCP stdio entry point (top-level await)
    '!src/mcp-http-entry.ts', // Exclude MCP HTTP entry point (top-level await)
    '!src/e2e/**', // E2E smoke scripts (Docker; top-level await in api-smoke)
  ],
  coverageDirectory: 'coverage',
  // json-summary feeds the CI job summary. text-summary keeps the pre-commit output short.
  coverageReporters: ['text-summary', 'json-summary', 'lcov', 'html'],
  // #144: on 2026-11-26 main had 90.68% of lines, 90.16% of statements, 86.56% of functions
  // and 85.37% of branches. The floor sits a little below, so that a change which drops
  // tests or adds untested code fails the gate.
  coverageThreshold: {
    global: { lines: 88, statements: 88, functions: 84, branches: 82 },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
};
