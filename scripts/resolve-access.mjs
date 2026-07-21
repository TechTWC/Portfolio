import { appendFileSync } from 'node:fs'

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
const appDomain = process.env.CLOUDFLARE_ACCESS_APP_DOMAIN?.trim()

if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required.')
if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required.')
if (!appDomain) throw new Error('CLOUDFLARE_ACCESS_APP_DOMAIN is required.')

const endpoint = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`)
endpoint.searchParams.set('domain', appDomain)
endpoint.searchParams.set('exact', 'true')
endpoint.searchParams.set('per_page', '50')

const response = await fetch(endpoint, {
  headers: {
    authorization: `Bearer ${apiToken}`,
    accept: 'application/json',
  },
})

const body = await response.json().catch(() => null)
if (!response.ok || !body?.success) {
  const details = body?.errors?.map((error) => error.message).filter(Boolean).join('; ')
  throw new Error(`Unable to list Cloudflare Access applications (${response.status}): ${details || 'unknown error'}`)
}

const applications = Array.isArray(body.result) ? body.result : []
const app = applications.find((item) => item?.domain === appDomain)
if (!app?.aud) {
  throw new Error(`No Access application with an AUD tag was found for ${appDomain}. Confirm the Worker URL is Restricted.`)
}

console.log(`Resolved Access application ${app.name || appDomain}: ${app.id || '(no id)'}`)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `access_aud=${app.aud}\n`)
}
