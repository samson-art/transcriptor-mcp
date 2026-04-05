import { getMcpRequestContext, runWithMcpRequestContext } from './mcp-request-context.js';

describe('mcp-request-context', () => {
  it('exposes clientApiKey inside runWithMcpRequestContext', () => {
    expect(getMcpRequestContext()).toBeUndefined();

    runWithMcpRequestContext({ clientApiKey: 'secret-1' }, () => {
      expect(getMcpRequestContext()?.clientApiKey).toBe('secret-1');
    });

    expect(getMcpRequestContext()).toBeUndefined();
  });

  it('propagates through async continuation in same tick', async () => {
    await runWithMcpRequestContext({ clientApiKey: 'async-key' }, async () => {
      await Promise.resolve();
      expect(getMcpRequestContext()?.clientApiKey).toBe('async-key');
    });
  });
});
