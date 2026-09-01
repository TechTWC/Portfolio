import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('isolated market refresh schedules', () => {
  it('keeps Staging and Production on distinct Workers, D1 databases and Cron times', () => {
    const staging = readFileSync('.github/workflows/deploy-staging.yml', 'utf8')
    const production = readFileSync('.github/workflows/deploy-personal-production.yml', 'utf8')

    expect(staging).toContain('CLOUDFLARE_WORKER_NAME: portfolio-analyzer-staging')
    expect(staging).toContain('CLOUDFLARE_D1_DATABASE_NAME: portfolio-analyzer-staging')
    expect(staging).toContain('CLOUDFLARE_MARKET_REFRESH_CRON: "0 23 * * 1-5"')
    expect(production).toContain('CLOUDFLARE_WORKER_NAME: portfolio-analyzer')
    expect(production).toContain('CLOUDFLARE_D1_DATABASE_NAME: portfolio-analyzer-production')
    expect(production).toContain('CLOUDFLARE_MARKET_REFRESH_CRON: "30 23 * * 1-5"')
  })
})
