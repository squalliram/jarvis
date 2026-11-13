import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { INSTAGRAM_PLUGIN_DIR, INSTAGRAM_PLUGIN_NAME, instagramSkills } from '../bridge/instagram.mjs'

const skillsDir = join(INSTAGRAM_PLUGIN_DIR, 'skills')

test('the Instagram plugin carries all thirteen ig-* skills', () => {
  const names = readdirSync(skillsDir).filter((n) => n.startsWith('ig-')).sort()
  assert.deepEqual(names, [
    'ig-audit', 'ig-caption', 'ig-carousel', 'ig-comment', 'ig-dm', 'ig-human', 'ig-plan',
    'ig-profile', 'ig-reel', 'ig-reply', 'ig-repurpose', 'ig-story', 'ig-viral',
  ])
  for (const name of names) {
    const skill = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`), `${name}/SKILL.md names itself`)
  }
  assert.deepEqual(instagramSkills(), names.map((n) => `${INSTAGRAM_PLUGIN_NAME}:${n}`))
})

test('the scoring tools ship beside the skills that run them', () => {
  for (const tool of [
    'ig-reel/hookscore.py', 'ig-reel/beats.py', 'ig-caption/caption.py',
    'ig-human/humanize.py', 'ig-human/detect.py', 'ig-viral/swipe.py',
  ]) {
    assert.ok(existsSync(join(skillsDir, tool)), `${tool} is present`)
  }
  assert.ok(existsSync(join(INSTAGRAM_PLUGIN_DIR, 'templates', 'voice.md')))
})

test('the plugin brings no MCP servers or hooks of its own', () => {
  assert.ok(!existsSync(join(INSTAGRAM_PLUGIN_DIR, '.mcp.json')))
  assert.ok(!existsSync(join(INSTAGRAM_PLUGIN_DIR, 'hooks')))
  const manifest = JSON.parse(readFileSync(join(INSTAGRAM_PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.mcpServers, undefined)
  assert.equal(manifest.hooks, undefined)
})
