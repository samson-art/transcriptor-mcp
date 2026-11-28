/**
 * The ChatGPT/Codex plugin in plugin/ (#75) names tools and the endpoint as text. Nothing
 * else fails when a tool is renamed or the endpoint moves, so this test does.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const skillsDir = path.join(root, 'plugin', 'skills');
const contract = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'mcp-tools-contract.json'), 'utf8')
) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
const toolNames = new Set(contract.map((tool) => tool.name));
const argNames = new Set(
  contract.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {}))
);
// Directories only: macOS Finder drops a .DS_Store here.
const skills = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('plugin skills', () => {
  it('has the 4 workflows of #75', () => {
    expect(skills.sort()).toEqual([
      'playlist-digest',
      'quote-video',
      'summarize-video',
      'video-frame',
    ]);
  });

  it.each(skills)('%s has a name, a description, steps and rules', (skill) => {
    const text = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    expect(front).toMatch(new RegExp(`^name: ${skill}$`, 'm'));
    expect(front).toMatch(/^description: \S.{20,}$/m);
    expect(text).toMatch(/^1\. /m);
    expect(text).toMatch(/^## Rules$/m);
  });

  it.each(skills)('%s names only tools that the server has', (skill) => {
    const text = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
    const named = [...text.matchAll(/`((?:get|search)_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !toolNames.has(name))).toEqual([]);
  });

  // The server drops an unknown argument key (ADR 010), so a renamed argument fails silently.
  it.each(skills)('%s names only arguments that the tools have', (skill) => {
    const text = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
    // Every word in backticks is a tool, an argument, or a value that the skills pass.
    const values = new Set(['auto', 'official', 'en', 'ru']);
    const args = [...text.matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]);
    expect(args.length).toBeGreaterThan(0);
    expect(
      args.filter((name) => !argNames.has(name) && !toolNames.has(name) && !values.has(name))
    ).toEqual([]);
  });

  it('points at the endpoint that the README and the site publish', () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'mcp.json'), 'utf8'));
    const site = fs.readFileSync(path.join(root, 'web', 'clients.mjs'), 'utf8');
    const serverUrl = /export const SERVER_URL = '([^']+)'/.exec(site)?.[1];
    expect(mcp.mcpServers.transcriptor.url).toBe(serverUrl);
  });
});
