# AI Read-Only Data Platform v0.1

## Purpose

Portfolio Analyzer remains the Source of Truth. ChatGPT is an analysis and interpretation layer that can read allowlisted business data only through the semantic platform at `/mcp`.

The MCP endpoint does not expose D1 schema, SQL, environment configuration, secrets, or mutation services.

## Architecture

```text
Existing Portfolio Domain Services
  -> PortfolioReadSession (SELECT-only read models)
  -> ResourceRegistry / MetricRegistry
  -> six stable MCP tools
  -> Cloudflare Access Managed OAuth
  -> ChatGPT
```

The server uses the current stateless `createMcpHandler` with Streamable HTTP. It does not use deprecated standalone SSE or the deprecated `McpAgent` server path.

Official references:

- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/auth
- https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/

## Stable MCP tools

1. `list_data_resources`
2. `describe_resource`
3. `query_data`
4. `list_metrics`
5. `get_metric`
6. `get_data_lineage`

Every tool is annotated read-only and non-destructive. There are no create, update, delete, correction, activation, deployment, migration, SQL, database, environment, or secret tools.

## Resource Registry

Production resources in v0.1:

- `portfolio_snapshot`
- `positions`
- `transactions`
- `cash_flows`
- `security_cash_flows`
- `valuations`
- `market_prices`
- `fx_rates`
- `data_quality`

Unknown resources, fields, filters, sort fields, cursors, and page sizes fail validation. The default page size is 100 and the maximum is 500.

Adding a Resource requires one registration and one read model. It does not require a new MCP tool or a change to the implementations of discovery, description, or query.

## Metric Registry

Verified metrics in v0.1:

- `nav`
- `twr`
- `security_xirr`
- `xirr`
- `max_drawdown`
- `realized_pl`
- `unrealized_pl`
- `cash_ratio`

Metric calculators call the existing Portfolio Analyzer domain services. The MCP layer does not reimplement NAV, TWR, XIRR, drawdown, cost basis, FX conventions, or valuation.

`security_xirr` is explicitly estimated: security purchases are negative cash flows, net sale proceeds are positive cash flows, and the terminal open-position market value is the final positive flow. It uses trade dates as cash-flow dates and excludes unrecorded dividends and corporate actions. The separate `xirr` metric remains the official account-level XIRR based only on dated external contributions, withdrawals, and terminal total assets.

When the required transactions, FX inputs and terminal position valuation are available and current, `security_xirr` and `security_cash_flows` return `ESTIMATED`, not `COMPLETE`. The value remains available, accompanied by machine-readable warnings for its security-only scope, unrecorded distributions and corporate actions, trade-date settlement assumption, and recorded-FX assumption. `ESTIMATED` means usable only within those disclosed assumptions; it never means complete total return.

Because corporate actions and total-return coverage are not complete, `twr` and `max_drawdown` return `INCOMPLETE` with a null value. The server does not present price-only history as official total return.

## Authentication and authorization

The Staging `/mcp` endpoint must be protected by a Cloudflare Access MCP server application with Managed OAuth enabled.

Access policy requirements:

- allow only the Portfolio owner email;
- deny all other identities;
- short OAuth access-token lifetime (5–15 minutes recommended by Cloudflare);
- longer grant session according to the owner's operational preference;
- allow only the required ChatGPT redirect URI;
- do not enable anonymous bypass rules.

Cloudflare resolves the opaque OAuth token and forwards a signed `Cf-Access-Jwt-Assertion`. The Worker verifies its issuer, audience, RS256 signature, email, and forwarded-email consistency. MCP additionally requires the identity to match an existing Portfolio user; it cannot create a user.

Authentication failure is fail-closed. The Worker does not contain OAuth client secrets or receive a Cloudflare API token.

## Audit

Migration `0007_ai_read_only_platform.sql` adds an append-only MCP invocation log containing:

- timestamp
- request ID
- authenticated identity
- tool
- Resource or Metric target
- success or failure
- duration
- returned row count
- error code

It never stores access tokens, secrets, passwords, full request arguments, or returned business rows. If the audit record cannot be written, the tool fails closed.

## Deployment gate

The code can be deployed to Staging only after CI passes. Before ChatGPT connection testing, enable Managed OAuth on the Staging Access MCP application and apply the same owner-only policy used by the website.

Do not merge or deploy Production until all Staging cases in the implementation brief pass, including the negative request to modify a transaction.
