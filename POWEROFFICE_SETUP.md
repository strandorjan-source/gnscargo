# PowerOffice invoice drafts

Cargo calls the `poweroffice` Supabase Edge Function with its current user session. The function validates the user with Auth, checks the database staff role, reloads the source order under RLS and calculates invoice lines from stored customer prices. Transporter cost and internal telephone numbers are not included.

The `Fakturagrunnlag og rapporter` section contains a collapsible PowerOffice panel. Load the connection, select an order from the current loading-date/customer filters, choose the matching PowerOffice customer and the freight/diesel products, then create a draft. Customer matching suggests a unique organization number or exact name match. Products must be selected explicitly because their sales accounts determine VAT. New customer creation remains in PowerOffice for this release.

The customer freight price and diesel surcharge form separate lines. The currency is NOK. The function creates `SalesOrders/Complete` with `SalesOrderStatus: Draft`; it has no send, post-payment or invoice-confirmation action. Users review and issue invoices in PowerOffice.

## Credentials and deployment

Apply `supabase/migrations/20261012182724_poweroffice_draft_integration.sql`. Deploy all three files in `supabase/functions/poweroffice`, entrypoint `index.ts`. Gateway legacy JWT validation is disabled because Cargo uses publishable keys and the function performs explicit `GET /auth/v1/user` validation followed by database role authorization. No action is available without a valid staff session.

The Vault entry `cargo_poweroffice_config` holds JSON with `environment`, `applicationKey`, `clientKey` and `subscriptionKey`. Only the service role can call `poweroffice_config`. No key belongs in this repository, browser code, test output or build logs. The deployed connection initially uses `environment: demo`. Production requires a separately authorized PowerOffice production application/client/subscription and reviewed customer/product mappings. Use `environment: production` only with those credentials. The API origin is fixed in code and cannot be supplied by a browser.

`poweroffice_exports` is read-only for active Cargo staff through RLS. API writes use the service role after authorization. Its primary key is `(order_id, environment)`; provider `ExternalImportReference` is `GNS-{environment}-{order UUID}`. A database claim locks the order revision. The original payload is immutable across retries. After a lost response, reconciliation looks for both an invoice and a draft before attempting the same uniquely referenced request. A concurrent request is rejected; stale claims are recoverable after two minutes. Never reset references or delete an export record to retry a real invoice.

The status button queries outgoing invoices first, then drafts. Invoice number, outstanding balance, due date and payment state are saved back to Cargo. These are provider snapshots as of the last status refresh, not real-time notifications. Demo status is kept separate from Cargo's existing manual production invoice flags. A source revision warning reminds staff to check changes made after export; a retry does not overwrite the original draft.

## Verification

`node tests/poweroffice.cjs` checks pricing, legacy/zero prices, rounding, privacy, draft state, role restrictions, stale revisions, retry after an accepted-but-lost provider response, invoice/payment-state mapping and DOM actions. It runs in `node scripts/release-check.cjs` together with the existing Cargo regression checks.

`node --use-env-proxy tests/poweroffice-live.cjs` runs only when explicitly invoked and receives test credentials through hidden stdin. It requires an ephemeral authenticated Cargo test user and PowerOffice **demo** keys. It creates clearly marked demo customer/products, a temporary Cargo test order through the actual order RPC, and invokes the deployed Edge Function through Cargo's actual UI handlers in JSDOM. It reads the resulting PowerOffice draft, checks line amounts, repeats the request and verifies one draft plus Cargo status. It never sends the draft. Remove the temporary Cargo records/account after testing; retain the marked PowerOffice demo draft as evidence if desired. Do not describe this as a real-browser login test or a live payment test.

Official API contracts used: https://developer.poweroffice.net/endpoints/sales-orders/transferring-orders and the linked SalesOrders, Products, Customers and OutgoingInvoices OpenAPI specifications.

Verified 12 October 2026 against the deployed Supabase function and the PowerOffice demo client: draft number **1**, net **43,600 NOK** (40,000 freight + 3,600 diesel), two lines, total **54,500 NOK** under the selected demo products. A repeated create produced the same draft; the provider had exactly one matching reference. Cargo status was read back as `draft`. Anonymous access and authenticated secret reads were rejected. Payment/reversal states were verified with fixtures; no invoice was sent and no live payment event was generated. The Cargo DOM flow was exercised in JSDOM with actual network calls.
