module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // ui/shared: the widgets' pure helpers (no React), the one part of ui/ a test can reach.
  roots: ['<rootDir>/src', '<rootDir>/ui/shared'],
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
    '!src/index.ts', // Exclude main entry point from coverage
    '!src/mcp.ts', // Exclude MCP stdio entry point (top-level await)
    '!src/mcp-http-entry.ts', // Exclude MCP HTTP entry point (top-level await)
    '!src/e2e/**', // E2E smoke scripts (Docker; top-level await in api-smoke)
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
};
