import type { FastifyBaseLogger } from 'fastify';

const mockOrder: string[] = [];
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: jest.fn(),
  flush: jest.fn(() => {
    mockOrder.push('flush');
    return Promise.resolve(true);
  }),
}));

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as FastifyBaseLogger;

/** Runs one shutdown with a fresh module (it keeps a "shutting down" flag) and no real exit. */
async function shutdownWith(close: () => Promise<void>, shutdownTimeout = 5000): Promise<string[]> {
  mockOrder.length = 0;
  let exited: () => void = () => undefined;
  const exitCalled = new Promise<void>((resolve) => (exited = resolve));
  const exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    mockOrder.push(`exit ${code}`);
    exited();
  }) as never);
  const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;
  const before = events.map((event) => process.listeners(event));
  try {
    await jest.isolateModulesAsync(async () => {
      const { setupLifecycle } = await import('./lifecycle.js');
      const shutdown = setupLifecycle({
        server: { close },
        closeCache: () => Promise.resolve(),
        log,
        shutdownTimeout,
      });
      // A forced exit leaves the shutdown pending, so wait for the exit, not for the shutdown.
      void shutdown('SIGTERM');
      await exitCalled;
    });
  } finally {
    exit.mockRestore();
    // setupLifecycle adds process listeners: remove the ones this run added.
    events.forEach((event, i) => {
      for (const listener of process.listeners(event)) {
        if (!before[i].includes(listener)) process.removeListener(event, listener as never);
      }
    });
  }
  return [...mockOrder];
}

describe('setupLifecycle shutdown', () => {
  it('sends what Sentry still holds before the process exits (#118)', async () => {
    expect(await shutdownWith(() => Promise.resolve())).toEqual(['flush', 'exit 0']);
  });

  it('also sends it when closing the server fails', async () => {
    expect(await shutdownWith(() => Promise.reject(new Error('close failed')))).toEqual([
      'flush',
      'exit 1',
    ]);
  });

  it('also sends it when a long call holds the close past the shutdown timeout', async () => {
    expect(await shutdownWith(() => new Promise(() => undefined), 10)).toEqual(['flush', 'exit 1']);
  });
});
