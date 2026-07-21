import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME?.trim() || 'portfolio-analyzer-staging'
const location = process.env.CLOUDFLARE_D1_LOCATION?.trim() || 'apac'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function runWrangler(args, options = {}) {
  return execFileSync(npx, ['wrangler', ...args], {
    encoding: 'utf8',
    env: process.env,
    ...options,
  })
}

function parseJsonArray(output) {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end < start) {
    throw new Error(`Wrangler did not return a JSON array: ${output}`)
  }
  return JSON.parse(output.slice(start, end + 1))
}

function listDatabases() {
  const output = runWrangler(['d1', 'list', '--json'])
  const parsed = parseJsonArray(output)
  return Array.isArray(parsed) ? parsed : []
}

function databaseId(database) {
  return database?.uuid || database?.id || database?.database_id || null
}

let database = listDatabases().find((item) => item.name === databaseName)

if (!database) {
  console.log(`D1 database ${databaseName} does not exist; creating it in ${location}.`)
  runWrangler(['d1', 'create', databaseName, '--location', location], { stdio: 'inherit' })
  database = listDatabases().find((item) => item.name === databaseName)
}

const id = databaseId(database)
if (!id) {
  throw new Error(`Could not resolve the database ID for ${databaseName}.`)
}

console.log(`Resolved D1 database ${databaseName}: ${id}`)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `database_id=${id}\n`)
}
