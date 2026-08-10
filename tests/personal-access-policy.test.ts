import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertPersonalPolicy, verifyPersonalAccess } from '../scripts/verify-personal-access.mjs'

const personalEmail = 'owner@example.com'
const productionWorkflow = readFileSync('.github/workflows/deploy-personal-production.yml', 'utf8')

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
})
