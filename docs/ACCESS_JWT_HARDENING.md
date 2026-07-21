# Cloudflare Access JWT Hardening

## Purpose

Cloudflare Access blocks unauthenticated visitors at the edge. The Worker must also validate the JWT attached to authenticated requests before trusting the user's Email or allowing D1 access.

## Validation contract

For every protected `/api/*` request, the Worker validates:

- header: `Cf-Access-Jwt-Assertion`
- signature: Cloudflare Access account signing key from JWKS
- algorithm: `RS256`
- issuer: `https://techtwc.cloudflareaccess.com`
- audience: the Portfolio Access application's AUD tag
- standard JWT time claims, including expiration
- JWT Email claim
- JWT Email matches `Cf-Access-Authenticated-User-Email` when that header is present

`/api/health` remains outside the authenticated API middleware for deployment diagnostics.

## GitHub environment setting

In GitHub environment `staging`, add:

```text
CLOUDFLARE_ACCESS_AUD
```

Value: copy the Application Audience (AUD) Tag from the Portfolio Cloudflare Access application.

The deployment workflow injects these Worker variables into the generated staging Wrangler configuration:

```text
AUTH_MODE=access
POLICY_AUD=<GitHub staging secret>
TEAM_DOMAIN=https://techtwc.cloudflareaccess.com
```

No development Email fallback is deployed to staging.

## Deployment acceptance

- CI tests, typecheck, build and staging config validation pass.
- Authenticated browser can call `/api/bootstrap` and see the existing ACTIVE dataset.
- Unauthenticated browser is stopped by Cloudflare Access.
- JWT with the wrong audience, issuer, signature or expired time is rejected by the Worker.
- Existing Revision 2 data remains unchanged during deployment.
