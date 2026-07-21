const baseUrl = (process.argv[2] || process.env.DEPLOYMENT_URL || '').replace(/\/$/, '')
if (!baseUrl) throw new Error('A deployment URL is required.')

const healthUrl = `${baseUrl}/api/health`
let lastError

for (let attempt = 1; attempt <= 10; attempt += 1) {
  try {
    const response = await fetch(healthUrl, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
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
