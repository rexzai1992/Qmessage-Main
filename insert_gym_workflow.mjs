import fs from 'node:fs'
import path from 'node:path'

const base = 'C:\\Users\\Admin\\Desktop\\Qmessage-Main'

function readEnv(filePath) {
  const env = {}
  const text = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    env[key] = value
  }
  return env
}

async function upsertWorkflow(body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  return { status: resp.status, ok: resp.ok, text }
}

const env = readEnv(path.join(base, '.env'))
const workflow = JSON.parse(fs.readFileSync(path.join(base, 'gym-workflow.json'), 'utf8'))
const url = env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/workflows?on_conflict=id'

const fullPayload = [{
  id: workflow.id,
  company_id: 'izzul-company',
  name: workflow.name || '',
  trigger_keyword: workflow.trigger_keyword || '',
  run_on_new_chat: workflow.run_on_new_chat === true,
  actions: workflow.actions || [],
  builder: workflow.builder || null,
  enabled: workflow.enabled !== false
}]

let result = await upsertWorkflow(fullPayload)
if (!result.ok && result.text.includes('run_on_new_chat')) {
  const fallbackPayload = fullPayload.map(({ run_on_new_chat, ...rest }) => rest)
  result = await upsertWorkflow(fallbackPayload)
}

console.log(result.status)
console.log(result.text)
if (!result.ok) process.exit(1)
