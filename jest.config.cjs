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
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
};
