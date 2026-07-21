const baseUrl = (process.argv[2] || process.env.DEPLOYMENT_URL || '').replace(/\/$/, '')
if (!baseUrl) throw new Error('A deployment URL is required.')

const healthUrl = `${baseUrl}/api/health`
let lastError

for (let attempt = 1; attempt <= 10; attempt += 1) {
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
    console.log(`Smoke test attempt ${attempt}/10 failed: ${String(error)}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

throw lastError
