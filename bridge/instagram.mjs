/**
 * The Instagram skill pack, loaded into JARVIS as a local plugin.
 *
 * The bridge runs with `settingSources: []`, so the SDK never looks in
 * ~/.claude/skills or a project's .claude/skills. Skills reach the session
 * only through the `plugins` option, which is why the pack lives here, in the
 * plugin layout (`.claude-plugin/plugin.json` + `skills/`), rather than in
 * either of those folders. Vendored from squalliram/instagram-agent-skill.
 *
 * The skills draft; they never post. Their shared state — voice.md, the swipe
 * file, the weekly plan and the post log — lives in ~/.claude/instagram, the
 * path every SKILL.md names, which is why that one folder is opened as a file
 * root inside an otherwise refused ~/.claude.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INSTAGRAM_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'plugins', 'instagram-agent')

export const INSTAGRAM_DATA_DIR = join(homedir(), '.claude', 'instagram')

export const INSTAGRAM_PLUGIN_NAME = JSON.parse(
  readFileSync(join(INSTAGRAM_PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
).name

/** Plugin-qualified names, as the SDK's `skills` option and Skill tool see them. */
export function instagramSkills() {
  return readdirSync(join(INSTAGRAM_PLUGIN_DIR, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('ig-'))
    .map((d) => `${INSTAGRAM_PLUGIN_NAME}:${d.name}`)
    .sort()
}
