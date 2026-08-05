# Shopee Affiliates integration

Phase 6A adds Shopee as another marketplace in the existing `Product`, `Offer`,
validation, scoring and import-audit pipeline. It does not create Publications,
run from the continuous worker or contact Shopee during the standard test suite.

## Confirm the affiliate account and export

Confirm manually that the account can access the Brazilian Shopee Affiliate
Portal and its reporting/export area. Export the CSV directly from that official
portal. Portal layouts and column names can change, so always run `inspect-csv`
before importing. Do not supply browser cookies, page HTML or a seller-platform
export as a substitute for an affiliate export.

The official Shopee help article describes creating affiliate links and using
Sub IDs: <https://help.shopee.com.br/portal/10/article/128461-Como-gerar-seus-links-de-Afiliado-ou-ID-de-produto-para-compartilhar>.

## Safe modes

Configuration is read only from the environment. The integration never writes
`.env` and the default is fail-closed:

```env
SHOPEE_AFFILIATE_ENABLED="false"
SHOPEE_AFFILIATE_MODE="OFF"
SHOPEE_AFFILIATE_CSV_MAX_BYTES="5000000"
SHOPEE_AFFILIATE_APP_ID=""
SHOPEE_AFFILIATE_SECRET=""
```

- `OFF`: no import, API request, Product, Offer, job or Publication is created.
- `CSV`: local inspect, preview/dry-run and explicitly confirmed imports are
  available. No credentials and no Shopee network request are needed.
- `OPEN_API`: reports `WAITING_FOR_OFFICIAL_ACCESS`. No request is implemented
  until the Brazilian Affiliate Open API contracts can be confirmed.

Missing, empty or unknown modes resolve to `OFF`. Credentials are exposed only
as a configured/not-configured boolean.

## Commands

```powershell
npm run shopee:affiliate:status
npm run shopee:affiliate:preflight
npm run shopee:affiliate:inspect-csv -- --file packages/shopee-affiliate/fixtures/official-export-sanitized.csv
npm run shopee:affiliate:import-csv -- --file packages/shopee-affiliate/fixtures/official-export-sanitized.csv --dry-run
npm run shopee:affiliate:import-csv -- --file C:\safe\official-export.csv --confirm-import
```

The final command writes only when both `SHOPEE_AFFILIATE_ENABLED=true` and
`SHOPEE_AFFILIATE_MODE=CSV` are set and `--confirm-import` is explicit. Without
that flag, the command is a dry-run with `databaseWrites: 0`. Inspect and dry-run
do not download images. The dashboard integration card is read-only.

The preview reports row and column counts, valid/invalid rows, duplicates,
existing/new Products, new/updatable Offers, ignored rows and error counts. It
does not print titles, affiliate URLs or tracking parameters.

## CSV aliases and supported fields

Aliases are explicit, accent-insensitive and case-insensitive. At minimum, the
export needs title, current price and product URL aliases.

| Field | Accepted aliases |
| --- | --- |
| Product ID | `Product ID`, `Item ID`, `ID do produto`, `productid`, `itemid` |
| Shop ID | `Shop ID`, `Seller ID`, `ID da loja`, `shopid`, `sellerid` |
| Title | `Product Name`, `Product Title`, `Nome do produto`, `Titulo`, `Title` |
| Current price | `Current Price`, `Sale Price`, `Preco atual`, `Price` |
| Original price | `Original Price`, `List Price`, `Preco original` |
| Product URL | `Product Link`, `Product URL`, `Link do produto`, `URL do produto` |
| Affiliate URL | `Offer Link`, `Affiliate Link`, `Link afiliado`, `Link da oferta` |
| Commission rate | `Commission Rate`, `Commission Percentage`, `Taxa de comissao`, `Comissao` |
| Commission value | `Commission`, `Commission Amount`, `Valor da comissao` |
| Other optional fields | category, image URL, shop/seller, currency and source timestamp aliases declared in the package |

The parser supports UTF-8, BOM, comma or semicolon delimiters, quoted fields,
escaped quotes and localized decimal commas. It never evaluates spreadsheet
formulas. Unsupported or missing structures produce row/header error codes; a
real official file can then be sanitized and used to extend the alias table.

## Normalization, versions and idempotency

The preferred Product key is `SHOPEE + shopId:productId`. If `shopId` or
`productId` is unavailable, the fallback is a truncated SHA-256 identity of the
validated canonical product URL. This avoids guessing a shop and prevents raw
tracking URLs from becoming an identifier.

Confirmed rows pass through `ingestOfferInTransaction`, so existing Products are
reused and relevant commercial changes follow the existing Offer fingerprint and
versioning rules. Reimporting a successfully processed file is detected by its
SHA-256 checksum and creates no duplicate. The whole business import is one
transaction; an unexpected failure rolls it back and leaves a sanitized failed
job for review. A dedicated Redis lock prevents concurrent confirmed imports.

The file itself is not stored. `ImportJob` stores checksum, mode, timestamps and
counts; `ImportJobItem` stores sanitized row numbers, identifiers, stage/status
and error codes. Optional commission value, currency and source timestamp remain
in sanitized item metadata because the current Offer schema has no equivalent
fields. Missing data stays null. An inconsistent original price is not used to
calculate a discount.

Official affiliate links are preserved exactly. Unknown tracking parameters are
not removed or overwritten and no external shortener is used. The Sub ID helper
produces deterministic, sanitized identifiers from channel, Publication, origin,
campaign and variant IDs; it is not appended automatically until official field
and length contracts are confirmed. Never put group names or message content in
a Sub ID.

## URL and secret safety

Product and affiliate URLs require HTTPS, no embedded credentials and an exact
official host or legitimate subdomain of `shopee.com.br`, `shopee.com` or
`shope.ee`. Image URLs additionally allow `susercontent.com`. Lookalike domains
such as `shopee.com.br.example.test` are rejected. This phase stores image URLs
only and performs no media request.

Secrets are environment-only, never persisted or printed. Rotate or revoke them
in the official affiliate portal, update the local environment, or completely
disable the integration with `SHOPEE_AFFILIATE_ENABLED=false` and mode `OFF`.

## Affiliate Open API limitation

Official Brazilian entry points were located at
<https://open-api.affiliate.shopee.com.br/explorer> and
<https://affiliate.shopee.com.br/open_api/document?type=overview>. In the current
environment the detailed authenticated contracts were not available for reliable
verification. Consequently base URL, authentication, signature, endpoints,
scopes, limits and Brazil-specific behavior are all marked unconfirmed and no
HTTP client exists.

The Affiliate Open API is not interchangeable with Shopee seller Open Platform
or AMS APIs. Those APIs must not be used for this publisher account unless
official affiliate documentation explicitly says so. Once official access is
available, verify every contract above before implementing the existing
fail-closed preflight interface.

Operational status and audit are read-only: they show mode, enablement, last
import counts, sanitized failure/abandoned/duplicate states and credential
booleans. They never repair jobs automatically.
