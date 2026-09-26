/**
 * Single source of truth for the per-client connect instructions.
 * Consumed by web/build.mjs, which renders the landing page's client
 * switcher, the one-click install row, and llms.txt from this data.
 *
 * Config schemas verified against each client's official docs on
 * 2026-08-15 — the `docs` URL on every entry is the source. The shapes
 * genuinely differ between clients (VS Code wants `servers` + type
 * "http", Windsurf wants `serverUrl`, Cline wants type "streamableHttp",
 * Zed wraps in `context_servers`), so don't "unify" them.
 */

export const SERVER_URL = 'https://transcriptor.gateway.mcpal.io/mcp';
export const CHATGPT_LISTING =
  'https://chatgpt.com/plugins/plugin_asdk_app_6a92e6e7ec10819189c404c0721c3207';
export const SERVER_NAME = 'transcriptor';

export const installLinks = {
  cursor: `https://cursor.com/install-mcp?name=${SERVER_NAME}&config=${Buffer.from(
    JSON.stringify({ url: SERVER_URL })
  ).toString('base64')}`,
  vscode: `https://vscode.dev/redirect/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(
    JSON.stringify({ type: 'http', url: SERVER_URL })
  )}`,
  lmstudio: `https://lmstudio.ai/install-mcp?name=${SERVER_NAME}&config=${Buffer.from(
    JSON.stringify({ url: SERVER_URL })
  ).toString('base64')}`,
};

/**
 * kind: 'steps' (prose instructions, trusted HTML), 'command' (shell),
 * or 'json' (config object rendered with JSON.stringify).
 * install: key into installLinks for a one-click button.
 * llms: plain-text one-liner for llms.txt; falls back to command/config.
 * endpoint: false hides the endpoint copy block (installed from a directory).
 * docs/docsLabel: optional help link under the panel.
 */
export const clients = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    kind: 'steps',
    // Listed in the plugin directory, so there is no endpoint to paste.
    endpoint: false,
    steps: [
      `Open <a href="${CHATGPT_LISTING}">Transcriptor in the ChatGPT plugin directory</a> and select <b>Install plugin</b>; sign in when asked`,
      'Or in ChatGPT: <b>Plugins</b> → search <b>Transcriptor</b> → <b>Install plugin</b>',
    ],
    after: 'Then mention <code>@Transcriptor</code> in a chat, or open <b>+</b> → <b>More</b>.',
    llms: `Plugins -> search "Transcriptor" -> Install plugin (${CHATGPT_LISTING}), then mention @Transcriptor in a chat`,
  },
  {
    id: 'codex',
    label: 'Codex',
    kind: 'steps',
    // ChatGPT and Codex share one plugin directory; one install covers both.
    endpoint: false,
    steps: [
      `Install <a href="${CHATGPT_LISTING}">Transcriptor from the plugin directory</a> — ChatGPT and Codex share it, one install covers both`,
      'In a Codex task: <b>Sources</b> → <b>Use plugins</b> → <b>Transcriptor</b>; in the CLI, <code>/plugins</code>',
    ],
    after: 'A new directory listing can take up to 6 hours to appear in Codex.',
    llms: `install Transcriptor from the ChatGPT plugin directory (${CHATGPT_LISTING}), shared with Codex; then Sources -> Use plugins -> Transcriptor, or /plugins in the CLI`,
  },
  {
    id: 'claude',
    label: 'Claude',
    kind: 'steps',
    steps: [
      'Open <a href="https://claude.ai/settings/connectors">Settings → Customize → Connectors</a>',
      'Select <b>Add</b> → <b>Add custom connector</b>',
      'Paste the endpoint, then select <b>Add</b>',
    ],
    after: 'Works on the web and in the desktop app.',
    llms: 'Settings -> Customize -> Connectors -> Add -> Add custom connector -> paste the endpoint',
    docs: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
    docsLabel: 'Claude connectors help',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'command',
    command: `claude mcp add --transport http ${SERVER_NAME} ${SERVER_URL}`,
    after: 'Then run <code>/mcp</code> and approve the sign-in in the browser.',
    docs: 'https://docs.claude.com/en/docs/claude-code/mcp',
    docsLabel: 'Claude Code MCP docs',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'json',
    file: '~/.cursor/mcp.json',
    config: { mcpServers: { [SERVER_NAME]: { url: SERVER_URL } } },
    install: 'cursor',
    docs: 'https://cursor.com/docs/context/mcp',
    docsLabel: 'Cursor MCP docs',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'json',
    file: '.vscode/mcp.json',
    config: { servers: { [SERVER_NAME]: { type: 'http', url: SERVER_URL } } },
    install: 'vscode',
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    docsLabel: 'VS Code MCP docs',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'json',
    file: 'mcp.json (Program → Install → Edit mcp.json)',
    config: { mcpServers: { [SERVER_NAME]: { url: SERVER_URL } } },
    install: 'lmstudio',
    docs: 'https://lmstudio.ai/docs/app/plugins/mcp',
    docsLabel: 'LM Studio MCP docs',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    kind: 'json',
    file: '~/.codeium/windsurf/mcp_config.json',
    config: { mcpServers: { [SERVER_NAME]: { serverUrl: SERVER_URL } } },
    docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    docsLabel: 'Windsurf MCP docs',
  },
  {
    id: 'cline',
    label: 'Cline',
    kind: 'json',
    file: 'cline_mcp_settings.json (MCP Servers → Configure)',
    config: { mcpServers: { [SERVER_NAME]: { type: 'streamableHttp', url: SERVER_URL } } },
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    docsLabel: 'Cline MCP docs',
  },
  {
    id: 'zed',
    label: 'Zed',
    kind: 'json',
    file: 'settings.json',
    config: { context_servers: { [SERVER_NAME]: { url: SERVER_URL } } },
    docs: 'https://zed.dev/docs/ai/mcp',
    docsLabel: 'Zed MCP docs',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'command',
    command: `gemini mcp add --transport http ${SERVER_NAME} ${SERVER_URL}`,
    docs: 'https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html',
    docsLabel: 'Gemini CLI MCP docs',
  },
  {
    id: 'json',
    label: 'JSON',
    kind: 'json',
    heading: 'Any MCP client',
    file: "your client's MCP config",
    config: { mcpServers: { [SERVER_NAME]: { url: SERVER_URL } } },
    docs: 'https://modelcontextprotocol.io/docs/develop/connect-remote-servers',
    docsLabel: 'MCP docs',
  },
];

export const tools = [
  { name: 'get_transcript', ask: 'Summarize this video for me', desc: "clean plain-text transcript in the video's original language, cursor-paged" },
  { name: 'get_raw_subtitles', ask: 'Give me the subtitles as an SRT file', desc: 'raw SRT or VTT content, in parts' },
  { name: 'get_available_subtitles', ask: 'Is there a German track for this video?', desc: 'lists official and auto caption languages' },
  { name: 'get_video_info', ask: 'Who published this and how many views?', desc: 'title, channel, views, likes, upload date, tags, thumbnails' },
  { name: 'get_video_chapters', ask: 'Go to the part about pricing', desc: 'chapter titles with start and end times' },
  { name: 'get_video_frame', ask: 'Show me the screen at 4:12', desc: 'a single still frame at any timecode (jpeg or png)' },
  { name: 'get_playlist_transcripts', ask: 'Get English transcripts for the first 5 videos in this playlist', desc: 'transcripts for a selection of playlist videos' },
  { name: 'search_videos', ask: 'Find recent videos about X', desc: 'YouTube search with date filters' },
];
