import type { Context, Next } from 'hono'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export type Bindings = {
  DB: D1Database
  AUTH_MODE?: 'access' | 'dev'
  DEV_USER_EMAIL?: string
  POLICY_AUD?: string
  TEAM_DOMAIN?: string
}

export type Variables = {
  user: { id: string; email: string }
}

const jwksByTeamDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function normalizedTeamDomain(value: string): string {
  return value.trim().replace(/\/$/, '')
}

function jwksFor(teamDomain: string) {
  const existing = jwksByTeamDomain.get(teamDomain)
  if (existing) return existing
  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
  jwksByTeamDomain.set(teamDomain, jwks)
  return jwks
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  policyAud: string,
): Promise<JWTPayload> {
  const normalizedDomain = normalizedTeamDomain(teamDomain)
  const { payload } = await jwtVerify(token, jwksFor(normalizedDomain), {
    issuer: normalizedDomain,
    audience: policyAud,
    algorithms: ['RS256'],
  })
  return payload
}

async function userIdForEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.toLowerCase()))
  return `usr_${Array.from(new Uint8Array(digest)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function authenticatedEmail(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Promise<string | Response> {
  if (c.env.AUTH_MODE === 'dev') {
    const devEmail = c.env.DEV_USER_EMAIL?.trim().toLowerCase()
    return devEmail || c.json({ error: '本機開發身分尚未設定' }, 503)
  }

  const teamDomain = c.env.TEAM_DOMAIN?.trim()
  const policyAud = c.env.POLICY_AUD?.trim()
  if (!teamDomain || !policyAud) {
    return c.json({ error: 'Cloudflare Access JWT 驗證參數尚未設定' }, 503)
  }

  const token = c.req.header('Cf-Access-Jwt-Assertion')
  if (!token) return c.json({ error: '缺少 Cloudflare Access JWT' }, 401)

  try {
    const payload = await verifyAccessJwt(token, teamDomain, policyAud)
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (!email) return c.json({ error: 'Access JWT 未包含有效 Email' }, 403)

    const forwardedEmail = c.req.header('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase()
    if (forwardedEmail && forwardedEmail !== email) {
      return c.json({ error: 'Access JWT 與身分標頭不一致' }, 403)
    }
    return email
  } catch (error) {
    console.warn('Cloudflare Access JWT validation failed', error)
    return c.json({ error: 'Cloudflare Access JWT 驗證失敗' }, 403)
  }
}

export async function requireUser(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const result = await authenticatedEmail(c)
  if (result instanceof Response) return result
  const email = result

  const id = await userIdForEmail(email)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET updated_at = datetime('now')`,
    ).bind(id, email),
    c.env.DB.prepare(
      `INSERT INTO portfolio_state (user_id, cloud_revision)
       VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING`,
    ).bind(id),
  ])
  c.set('user', { id, email })
  await next()
}
