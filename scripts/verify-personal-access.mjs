const cloudflareApi = 'https://api.cloudflare.com/client/v4'

function required(value, name) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required.`)
  return normalized
}

async function cloudflareJson(fetchImpl, url, apiToken) {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: 'application/json',
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) {
    const details = body?.errors?.map((error) => error.message).filter(Boolean).join('; ')
    throw new Error(`Cloudflare Access verification failed (${response.status}): ${details || 'unknown error'}`)
  }
  return body.result
}

function isOnlyExpectedEmail(rule, expectedEmail) {
  const keys = rule && typeof rule === 'object' ? Object.keys(rule) : []
  if (keys.length !== 1 || keys[0] !== 'email') return false
  const email = rule.email?.email
  return typeof email === 'string' && email.trim().toLowerCase() === expectedEmail
}

export function assertPersonalPolicy(policies, expectedEmail) {
  if (!Array.isArray(policies) || policies.length !== 1) {
    throw new Error('Personal Production requires exactly one Access policy.')
  }

  const policy = policies[0]
  if (policy?.decision !== 'allow') {
    throw new Error('The only Personal Production Access policy must use the Allow decision.')
  }
  if (!Array.isArray(policy.include) || policy.include.length !== 1
      || !isOnlyExpectedEmail(policy.include[0], expectedEmail)) {
    throw new Error('The Personal Production Allow policy must include only the configured personal Email.')
  }
  if ((policy.exclude?.length ?? 0) !== 0 || (policy.require?.length ?? 0) !== 0) {
    throw new Error('The Personal Production Access policy must not add exclude or require rules.')
  }
}

export async function verifyPersonalAccess({
  apiToken,
  accountId,
  appDomain,
  personalEmail,
  fetchImpl = fetch,
}) {
  const token = required(apiToken, 'CLOUDFLARE_API_TOKEN')
  const account = required(accountId, 'CLOUDFLARE_ACCOUNT_ID')
  const domain = required(appDomain, 'CLOUDFLARE_ACCESS_APP_DOMAIN')
  const expectedEmail = required(personalEmail, 'CLOUDFLARE_PERSONAL_EMAIL').toLowerCase()

  const applicationsUrl = new URL(`${cloudflareApi}/accounts/${account}/access/apps`)
  applicationsUrl.searchParams.set('domain', domain)
  applicationsUrl.searchParams.set('exact', 'true')
  applicationsUrl.searchParams.set('per_page', '50')
  const applications = await cloudflareJson(fetchImpl, applicationsUrl, token)
  const matches = Array.isArray(applications)
    ? applications.filter((application) => application?.domain === domain)
    : []
  if (matches.length !== 1 || !matches[0]?.id || !matches[0]?.aud) {
    throw new Error(`Personal Production requires exactly one Access application with an AUD tag for ${domain}.`)
  }

  const policiesUrl = new URL(`${cloudflareApi}/accounts/${account}/access/apps/${matches[0].id}/policies`)
  policiesUrl.searchParams.set('per_page', '1000')
  const policies = await cloudflareJson(fetchImpl, policiesUrl, token)
  assertPersonalPolicy(policies, expectedEmail)

  return { appId: matches[0].id, audience: matches[0].aud }
}

async function main() {
  const result = await verifyPersonalAccess({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    appDomain: process.env.CLOUDFLARE_ACCESS_APP_DOMAIN,
    personalEmail: process.env.CLOUDFLARE_PERSONAL_EMAIL,
  })
  console.log(`Verified one-person Cloudflare Access policy for application ${result.appId}.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
