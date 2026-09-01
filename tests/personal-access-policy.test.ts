import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertPersonalPolicy, verifyPersonalAccess } from '../scripts/verify-personal-access.mjs'
import { assertAccessEnforced, probeAccessEnforcement } from '../scripts/probe-access-enforcement.mjs'

const personalEmail = 'owner@example.com'
const productionWorkflow = readFileSync('.github/workflows/deploy-personal-production.yml', 'utf8')

function workflowStep(name: string) {
  const marker = `      - name: ${name}\n`
  const start = productionWorkflow.indexOf(marker)
  if (start < 0) throw new Error(`Workflow step not found: ${name}`)
  const end = productionWorkflow.indexOf('\n      - ', start + marker.length)
  return productionWorkflow.slice(start, end < 0 ? undefined : end)
}

function response(result: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ success: status === 200, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

describe('Personal Production Access policy gate', () => {
  it('accepts exactly one Allow policy for the configured Email', () => {
    expect(() => assertPersonalPolicy([
      { decision: 'allow', include: [{ email: { email: 'OWNER@example.com' } }] },
    ], personalEmail)).not.toThrow()
  })

  it.each([
    ['everyone', [{ decision: 'allow', include: [{ everyone: {} }] }]],
    ['a domain', [{ decision: 'allow', include: [{ email_domain: { domain: 'example.com' } }] }]],
    ['a second Email', [{
      decision: 'allow',
      include: [
        { email: { email: personalEmail } },
        { email: { email: 'second@example.com' } },
      ],
    }]],
    ['a bypass policy', [{ decision: 'bypass', include: [{ everyone: {} }] }]],
    ['multiple policies', [
      { decision: 'allow', include: [{ email: { email: personalEmail } }] },
      { decision: 'deny', include: [{ everyone: {} }] },
    ]],
    ['an extra require rule', [{
      decision: 'allow',
      include: [{ email: { email: personalEmail } }],
      require: [{ country: { country_code: 'TW' } }],
    }]],
  ])('rejects %s', (_label, policies) => {
    expect(() => assertPersonalPolicy(policies, personalEmail)).toThrow()
  })

  it('resolves one application and validates its application policies', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => response([{ id: 'app-id', aud: 'app-aud', domain: 'portfolio-analyzer.techtwc.workers.dev' }]))
      .mockImplementationOnce(() => response([
        { decision: 'allow', include: [{ email: { email: personalEmail } }] },
      ]))

    await expect(verifyPersonalAccess({
      apiToken: 'token',
      accountId: 'account',
      appDomain: 'portfolio-analyzer.techtwc.workers.dev',
      personalEmail,
      fetchImpl,
    })).resolves.toEqual({ appId: 'app-id', audience: 'app-aud' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/access/apps/app-id/policies')
  })

  it('does not expose the configured Email in policy validation errors', () => {
    expect(() => assertPersonalPolicy([
      { decision: 'allow', include: [{ email: { email: 'wrong@example.com' } }] },
    ], personalEmail)).toThrowError(/configured personal Email/)
    try {
      assertPersonalPolicy([{ decision: 'allow', include: [{ everyone: {} }] }], personalEmail)
    } catch (error) {
      expect(String(error)).not.toContain(personalEmail)
    }
  })
})

describe('Personal Production deployment gate', () => {
  it('is manual, environment-protected and pinned to the current main SHA', () => {
    expect(productionWorkflow).toContain('workflow_dispatch:')
    expect(productionWorkflow).not.toMatch(/\npush:/)
    expect(productionWorkflow).toContain('environment: production')
    expect(productionWorkflow).toContain('Full 40-character SHA currently at main')
    expect(productionWorkflow).toContain('git fetch --no-tags --depth=1 origin main')
    expect(productionWorkflow).toContain('Requested commit is not the current main HEAD')
  })

  it('refuses to enter the Production job from a stale branch or tag workflow ref', () => {
    const deployJobHeader = productionWorkflow.slice(
      productionWorkflow.indexOf('  deploy:'),
      productionWorkflow.indexOf('    steps:'),
    )
    expect(deployJobHeader).toContain("if: github.ref == 'refs/heads/main'")
    expect(deployJobHeader.indexOf("if: github.ref == 'refs/heads/main'"))
      .toBeLessThan(deployJobHeader.indexOf('environment: production'))
    expect(deployJobHeader).not.toContain('refs/tags/')
  })

  it('verifies owner-only Access before creating or migrating production D1', () => {
    const accessGate = productionWorkflow.indexOf('node scripts/verify-personal-access.mjs')
    const d1Resolution = productionWorkflow.indexOf('node scripts/resolve-d1.mjs')
    const migration = productionWorkflow.indexOf('wrangler d1 migrations apply')
    expect(accessGate).toBeGreaterThan(0)
    expect(d1Resolution).toBeGreaterThan(accessGate)
    expect(migration).toBeGreaterThan(d1Resolution)
  })

  it('uses resources isolated from staging and never prints the Email secret', () => {
    expect(productionWorkflow).toContain('CLOUDFLARE_D1_DATABASE_NAME: portfolio-analyzer-production')
    expect(productionWorkflow).toContain('CLOUDFLARE_WORKER_NAME: portfolio-analyzer')
    expect(productionWorkflow).not.toContain('portfolio-analyzer-staging')
    expect(productionWorkflow).not.toContain('echo "$CLOUDFLARE_PERSONAL_EMAIL"')
    expect(productionWorkflow).not.toContain('echo "${CLOUDFLARE_PERSONAL_EMAIL}"')
  })

  it('does not expose Production secrets to checkout, install, validation or build', () => {
    const jobScope = productionWorkflow.slice(
      productionWorkflow.indexOf('    environment: production'),
      productionWorkflow.indexOf('    steps:'),
    )
    expect(jobScope).not.toContain('${{ secrets.')

    for (const stepName of ['Install locked dependencies', 'Validate application']) {
      const step = workflowStep(stepName)
      expect(step).not.toMatch(/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID|PERSONAL_EMAIL)/)
      expect(step).not.toContain('${{ secrets.')
    }

    const setupSection = productionWorkflow.slice(
      productionWorkflow.indexOf('      - uses: actions/checkout@v4'),
      productionWorkflow.indexOf('      - name: Check protected personal Email input'),
    )
    expect(setupSection).not.toContain('${{ secrets.')
  })

  it('limits the personal Email secret to input and Access-policy checks', () => {
    const emailBindings = productionWorkflow.match(/CLOUDFLARE_PERSONAL_EMAIL: \$\{\{ secrets\.CLOUDFLARE_PERSONAL_EMAIL \}\}/g)
    expect(emailBindings).toHaveLength(3)
    for (const stepName of [
      'Check protected personal Email input',
      'Verify one-person Cloudflare Access policy',
      'Re-verify one-person Access after deployment',
    ]) {
      expect(workflowStep(stepName)).toContain('CLOUDFLARE_PERSONAL_EMAIL: ${{ secrets.CLOUDFLARE_PERSONAL_EMAIL }}')
    }
  })

  it('limits Cloudflare credentials to API, D1, migration and deploy steps', () => {
    const credentialSteps = [
      'Verify one-person Cloudflare Access policy',
      'Resolve or create production D1',
      'Resolve Cloudflare Access audience',
      'Apply D1 migrations',
      'Deploy Personal Production Worker',
      'Re-verify one-person Access after deployment',
    ]
    expect(productionWorkflow.match(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/g))
      .toHaveLength(credentialSteps.length)
    expect(productionWorkflow.match(/CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/g))
      .toHaveLength(credentialSteps.length)
    for (const stepName of credentialSteps) {
      const step = workflowStep(stepName)
      expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
      expect(step).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    }
    expect(workflowStep('Check protected personal Email input')).not.toMatch(/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/)
  })

  it('reports Access enforcement without claiming an authenticated Worker health check', () => {
    expect(workflowStep('Verify unauthenticated requests are blocked by Access'))
      .toContain('node scripts/probe-access-enforcement.mjs')
    expect(productionWorkflow).not.toContain('node scripts/smoke-test.mjs')
    expect(productionWorkflow).not.toContain('Health check: passed')
    expect(productionWorkflow).toContain('Access enforcement probe: passed')
    expect(productionWorkflow).toContain('Authenticated Worker health check: pending manual acceptance')
  })
})

describe('Personal Production Access enforcement probe', () => {
  const options = {
    deploymentUrl: 'https://portfolio-analyzer.techtwc.workers.dev',
    teamDomain: 'https://techtwc.cloudflareaccess.com',
  }

  it('accepts only a login redirect on the configured Access team domain', () => {
    const valid = new Response(null, {
      status: 302,
      headers: { location: 'https://techtwc.cloudflareaccess.com/cdn-cgi/access/login/portfolio-analyzer' },
    })
    expect(assertAccessEnforced(valid, options)).toMatch(/redirect/)

    const external = new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/cdn-cgi/access/login/portfolio-analyzer' },
    })
    expect(() => assertAccessEnforced(external, options)).toThrow(/does not prove/)
  })

  it('accepts a 401 only with Access OAuth metadata for the protected deployment', () => {
    const valid = new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': 'Bearer realm="OAuth", resource_metadata="https://portfolio-analyzer.techtwc.workers.dev/.well-known/cloudflare-access-protected-resource/"',
      },
    })
    expect(assertAccessEnforced(valid, options)).toMatch(/OAuth challenge/)
    expect(() => assertAccessEnforced(new Response(null, { status: 401 }), options)).toThrow(/does not prove/)
  })

  it('accepts the Managed OAuth invalid_token body returned for the protected health resource', async () => {
    const responseBody = {
      error: 'invalid_token',
      error_description: 'Missing or invalid access token',
      resource_metadata: 'https://portfolio-analyzer.techtwc.workers.dev/.well-known/cloudflare-access-protected-resource/api/health',
    }
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(probeAccessEnforcement({
      ...options,
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
    })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('/api/health', options.deploymentUrl),
      expect.objectContaining({ redirect: 'manual' }),
    )
  })

  it('rejects Managed OAuth JSON that points outside the protected deployment', () => {
    const response = new Response(null, { status: 401 })
    expect(() => assertAccessEnforced(response, {
      ...options,
      responseBody: {
        error: 'invalid_token',
        resource_metadata: 'https://attacker.example/.well-known/cloudflare-access-protected-resource/api/health',
      },
    })).toThrow(/does not prove/)
  })

  it('rejects a generic Cloudflare 403 because edge markers do not prove Access', () => {
    const genericEdgeRejection = new Response(null, {
      status: 403,
      headers: { server: 'cloudflare', 'cf-ray': '7109408e6b84efe4-EWR' },
    })
    expect(() => assertAccessEnforced(genericEdgeRejection, options)).toThrow(/does not prove/)
    expect(() => assertAccessEnforced(new Response(null, { status: 403 }), options)).toThrow(/does not prove/)
  })

  it('rejects an origin health response because it does not prove Access protection', () => {
    const health = new Response(JSON.stringify({ ok: true, service: 'portfolio-analyzer-cloud' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    expect(() => assertAccessEnforced(health, options)).toThrow(/does not prove/)
  })
})
