import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = process.argv[2] || 'wrangler.jsonc'
const outputPath = process.argv[3] || '.wrangler.staging.generated.jsonc'
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim()
const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME?.trim() || 'portfolio-analyzer-staging'
const workerName = process.env.CLOUDFLARE_WORKER_NAME?.trim() || 'portfolio-analyzer-staging'

if (!databaseId) {
  throw new Error('CLOUDFLARE_D1_DATABASE_ID is required.')
}

const config = JSON.parse(readFileSync(sourcePath, 'utf8'))
const binding = config.d1_databases?.find((item) => item.binding === 'DB')
if (!binding) {
  throw new Error('wrangler.jsonc does not contain the DB binding.')
}

config.name = workerName
binding.database_name = databaseName
binding.database_id = databaseId
config.observability = { enabled: true }

if (config.vars?.AUTH_MODE === 'dev') {
  throw new Error('Development authentication must not be enabled in a cloud deployment.')
}

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Rendered ${outputPath} for Worker ${workerName} and D1 ${databaseName}.`)
