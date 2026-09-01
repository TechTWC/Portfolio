import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = process.argv[2] || 'wrangler.jsonc'
const outputPath = process.argv[3] || '.wrangler.staging.generated.jsonc'
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim()
const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME?.trim() || 'portfolio-analyzer-staging'
const workerName = process.env.CLOUDFLARE_WORKER_NAME?.trim() || 'portfolio-analyzer-staging'
const policyAud = process.env.CLOUDFLARE_ACCESS_AUD?.trim()
const teamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, '')
const marketRefreshCron = process.env.CLOUDFLARE_MARKET_REFRESH_CRON?.trim()

if (!databaseId) throw new Error('CLOUDFLARE_D1_DATABASE_ID is required.')
if (!policyAud) throw new Error('CLOUDFLARE_ACCESS_AUD is required.')
if (!teamDomain) throw new Error('CLOUDFLARE_ACCESS_TEAM_DOMAIN is required.')
if (!marketRefreshCron) throw new Error('CLOUDFLARE_MARKET_REFRESH_CRON is required.')

const config = JSON.parse(readFileSync(sourcePath, 'utf8'))
const binding = config.d1_databases?.find((item) => item.binding === 'DB')
if (!binding) throw new Error('wrangler.jsonc does not contain the DB binding.')

config.name = workerName
binding.database_name = databaseName
binding.database_id = databaseId
config.observability = { enabled: true }
config.triggers = { ...(config.triggers ?? {}), crons: [marketRefreshCron] }
config.vars = {
  ...(config.vars ?? {}),
  AUTH_MODE: 'access',
  POLICY_AUD: policyAud,
  TEAM_DOMAIN: teamDomain,
}
delete config.vars.DEV_USER_EMAIL

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Rendered ${outputPath} for Worker ${workerName}, D1 ${databaseName}, and Access JWT validation.`)
