/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/deploy-staging.yml', 'utf8')
const resolver = readFileSync('scripts/resolve-access.mjs', 'utf8')
const renderer = readFileSync('scripts/render-wrangler-config.mjs', 'utf8')
const auth = readFileSync('worker/auth.ts', 'utf8')

describe('Cloudflare Access JWT hardening configuration', () => {
  it('resolves the Access audience from the Cloudflare API during deployment', () => {
    expect(workflow).toContain('Resolve Cloudflare Access audience')
    expect(workflow).toContain('node scripts/resolve-access.mjs')
    expect(workflow).toContain('CLOUDFLARE_ACCESS_AUD: ${{ steps.access.outputs.access_aud }}')
    expect(resolver).toContain('/access/apps')
    expect(resolver).toContain('access_aud=')
  })

  it('injects access mode, audience and team domain into generated config', () => {
    expect(renderer).toContain("AUTH_MODE: 'access'")
    expect(renderer).toContain('POLICY_AUD: policyAud')
    expect(renderer).toContain('TEAM_DOMAIN: teamDomain')
    expect(renderer).toContain('delete config.vars.DEV_USER_EMAIL')
  })

  it('verifies signature, issuer, audience and RS256 algorithm', () => {
    expect(auth).toContain("c.req.header('Cf-Access-Jwt-Assertion')")
    expect(auth).toContain('jwtVerify(token')
    expect(auth).toContain('issuer: normalizedDomain')
    expect(auth).toContain('audience: policyAud')
    expect(auth).toContain("algorithms: ['RS256']")
  })
})
