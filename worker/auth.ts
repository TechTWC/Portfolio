import type { Context, Next } from 'hono'

export type Bindings = {
  DB: D1Database
  AUTH_MODE?: 'access' | 'dev'
  DEV_USER_EMAIL?: string
}

export type Variables = {
  user: { id: string; email: string }
}

async function userIdForEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.toLowerCase()))
  return `usr_${Array.from(new Uint8Array(digest)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export async function requireUser(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const accessEmail = c.req.header('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase()
  const devEmail = c.env.AUTH_MODE === 'dev' ? c.env.DEV_USER_EMAIL?.trim().toLowerCase() : undefined
  const email = accessEmail || devEmail
  if (!email) return c.json({ error: '未通過 Cloudflare Access 驗證' }, 401)

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
