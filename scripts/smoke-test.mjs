const baseUrl = (process.argv[2] || process.env.DEPLOYMENT_URL || '').replace(/\/$/, '')
if (!baseUrl) throw new Error('A deployment URL is required.')

const healthUrl = `${baseUrl}/api/health`
const maxAttempts = Number.parseInt(process.env.SMOKE_MAX_ATTEMPTS || '10', 10)
const retryDelayMs = Number.parseInt(process.env.SMOKE_RETRY_DELAY_MS || '3000', 10)
let lastError

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    const response = await fetch(healthUrl, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    })

    const location = response.headers.get('location') || ''
    if ([301, 302, 303, 307, 308].includes(response.status) && /cloudflareaccess|cdn-cgi\/access/i.test(location)) {
      console.log(`Smoke test passed: deployment is reachable and protected by Cloudflare Access (${response.status}).`)
      process.exit(0)
    }

    if (response.status === 401) {
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      const expectedMetadata = `${baseUrl}/.well-known/cloudflare-access-protected-resource/api/health`
      if (
        body?.error === 'invalid_token'
        && body?.resource_metadata === expectedMetadata
      ) {
        console.log('Smoke test passed: deployment is reachable and protected by Cloudflare Access Managed OAuth (401).')
        process.exit(0)
      }
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      const text = await response.text()
      if (/cloudflare access|cdn-cgi\/access|sign in/i.test(text)) {
        console.log('Smoke test passed: deployment is reachable and protected by Cloudflare Access.')
        process.exit(0)
      }
      throw new Error(`Expected JSON health response but received ${contentType || 'unknown content type'}`)
    }

    const body = await response.json()
    if (body.ok !== true || body.service !== 'portfolio-analyzer-cloud') {
      throw new Error(`Unexpected health response: ${JSON.stringify(body)}`)
    }

    console.log(`Smoke test passed: ${healthUrl}`)
    process.exit(0)
  } catch (error) {
    lastError = error
    console.log(`Smoke test attempt ${attempt}/${maxAttempts} failed: ${String(error)}`)
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
}

throw lastError
