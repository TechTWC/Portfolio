const redirectStatuses = new Set([301, 302, 303, 307, 308])

function requiredUrl(value, name) {
  const normalized = value?.trim().replace(/\/$/, '')
  if (!normalized) throw new Error(`${name} is required.`)
  const url = new URL(normalized)
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`)
  return url
}

function accessRedirect(response, teamUrl) {
  if (!redirectStatuses.has(response.status)) return false
  const location = response.headers.get('location')
  if (!location) return false

  const redirectUrl = new URL(location)
  return redirectUrl.origin === teamUrl.origin
    && redirectUrl.pathname.startsWith('/cdn-cgi/access/')
}

function oauthChallenge(response, deploymentUrl) {
  if (response.status !== 401) return false
  const challenge = response.headers.get('www-authenticate') || ''
  const metadata = challenge.match(/resource_metadata="([^"]+)"/i)?.[1]
  if (!/^Bearer\b/i.test(challenge) || !metadata) return false

  const metadataUrl = new URL(metadata)
  return metadataUrl.origin === deploymentUrl.origin
    && metadataUrl.pathname === '/.well-known/cloudflare-access-protected-resource/'
}

function cloudflareForbidden(response) {
  if (response.status !== 403) return false
  const server = response.headers.get('server') || ''
  const ray = response.headers.get('cf-ray') || ''
  return server.toLowerCase() === 'cloudflare'
    && /^[0-9a-f]{8,32}-[a-z0-9]{3,10}$/i.test(ray)
}

export function assertAccessEnforced(response, { deploymentUrl, teamDomain }) {
  const deployment = requiredUrl(deploymentUrl, 'DEPLOYMENT_URL')
  const team = requiredUrl(teamDomain, 'CLOUDFLARE_ACCESS_TEAM_DOMAIN')

  if (accessRedirect(response, team)) return `Access login redirect (${response.status})`
  if (oauthChallenge(response, deployment)) return 'Access OAuth challenge (401)'
  if (cloudflareForbidden(response)) return 'Cloudflare Access rejection (403)'

  throw new Error(`Response does not prove Cloudflare Access enforcement (HTTP ${response.status}).`)
}

export async function probeAccessEnforcement({
  deploymentUrl,
  teamDomain,
  fetchImpl = fetch,
  attempts = 10,
  retryDelayMs = 3000,
}) {
  const baseUrl = requiredUrl(deploymentUrl, 'DEPLOYMENT_URL')
  const healthUrl = new URL('/api/health', baseUrl)
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(healthUrl, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
      })
      const result = assertAccessEnforced(response, {
        deploymentUrl: baseUrl.href,
        teamDomain,
      })
      console.log(`Access enforcement probe passed: ${result}.`)
      return
    } catch (error) {
      lastError = error
      console.log(`Access enforcement attempt ${attempt}/${attempts} failed: ${String(error)}`)
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  throw lastError
}

if (import.meta.url === `file://${process.argv[1]}`) {
  probeAccessEnforcement({
    deploymentUrl: process.argv[2] || process.env.DEPLOYMENT_URL,
    teamDomain: process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
