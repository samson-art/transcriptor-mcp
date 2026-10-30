import { Readable } from 'node:stream';

import { readFirstLineAsJson } from './docker-utils.js';

// The answer of the stdio server to `initialize`, as the SDK writes it: one JSON line.
const RESPONSE =
  '{"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"transcriptor-mcp","version":"1.5.21"}},"jsonrpc":"2.0","id":1}';
// What `npm run start:mcp` of 1.5.21 printed to stdout before the server started (#81).
const NPM_BANNER =
  '\n> transcriptor-mcp@1.5.21 start:mcp\n> node --import ./dist/instrument.js dist/mcp.js\n\n';

describe('readFirstLineAsJson', () => {
  it.each([
    ['the npm script banner', NPM_BANNER],
    ['a blank line', '\n'],
  ])('fails when %s comes before the first message', async (_name, before) => {
    await expect(readFirstLineAsJson(Readable.from([before + RESPONSE + '\n']))).rejects.toThrow(
      'The first stdout line is not JSON'
    );
  });

  it('resolves with the first line when it is the message', async () => {
    await expect(readFirstLineAsJson(Readable.from([RESPONSE + '\n']))).resolves.toEqual(
      JSON.parse(RESPONSE)
    );
  });
});
