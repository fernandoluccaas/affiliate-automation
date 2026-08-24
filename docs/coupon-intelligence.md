# Cross-marketplace Coupon Intelligence

## Estado da integração

Coupon Intelligence é uma camada opt-in e fail-closed para Shopee e Mercado
Livre. Ela resolve, persiste, ranqueia e publica apenas fatos de cupom sustentados
por uma fonte oficial. Ausência de cupom nunca bloqueia o fluxo normal da oferta.

Na auditoria desta fase, nenhuma descoberta genérica de cupom afiliado foi
encontrada nos contratos oficiais já implementados:

- Shopee: as colunas do Datafeed em
  `packages/shopee-affiliate/src/official-feed-contract.ts` e a seleção
  `productOfferV2` em `official-product-offer-contract.ts` não contêm voucher,
  coupon ou promotion. O provider retorna
  `SHOPEE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE` e faz zero requests.
- Mercado Livre: o client existente usa OAuth para items, prices, products,
  user products, highlights e categorias. Os recursos autorizados da sessão de
  afiliado geram links e tags, mas não expõem cupons. O provider retorna
  `MERCADO_LIVRE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE` e faz zero requests.
  Nenhum scope/token configurado no projeto comprova acesso a cupom afiliado
  genérico. Recursos seller-side de promoções não foram tratados como capacidade
  de uma conta publisher.

Não foram inventados endpoints, campos GraphQL, scopes ou capacidades. Os
providers são pontos de extensão para um contrato oficial futuro.

## Domínio e fluxo

`CouponProvider` produz `CouponCandidate[]`. O resolver compartilhado valida
marketplace, status, período, margem de expiração, produto, seller/store, escopo,
compra mínima e aplicabilidade. Ele não empilha cupons. A ordem determinística é:
maior economia real, maior percentual efetivo, maior confiança, menor compra
mínima, maior validade e `sourceKey`.

Somente `CONFIRMED` calcula `effectivePrice`. `CONDITIONAL` pode informar a
condição, mas não reduz artificialmente o preço. `UNKNOWN` ou
`NOT_APPLICABLE` não participa de preço nem ranking. Dinheiro é calculado por
inteiros decimais escalados, sem floating point para a economia.

O fluxo é:

```text
fonte oficial -> CouponProvider -> CouponCandidate[] -> resolver
-> Coupon atual da Offer -> ranking opt-in -> Publication.couponSnapshot
-> freshness pré-transporte -> mensagem compartilhada -> /go/<slug>
```

O limite `COUPON_DISCOVERY_MAX_PER_CYCLE` prepara o enrichment de shortlist. Os
providers atuais não consomem esse limite porque não fazem requests.

## Persistência e idempotência

O modelo `Coupon` existente foi ampliado de forma aditiva. A unicidade
`offerId + sourceKey` permite upsert determinístico. Com ID oficial, a chave usa
source + external ID; sem ID, usa somente campos oficiais estáveis. Refresh marca
cupons desaparecidos da mesma fonte como inativos e não cria duplicatas.

`Publication.couponSnapshot` é JSON estruturado e histórico. Ele registra
marketplace, ID/chave, código, tipo, benefício, compra mínima, desconto máximo,
auto-apply, escopo, aplicabilidade, período, validação, source, preço avaliado,
economia e preço efetivo. Publications já publicadas nunca são regravadas.

A migration aditiva está em
`prisma/migrations/20260824190000_cross_marketplace_coupon_intelligence`.
Ela não foi aplicada nesta implementação. No guided retest, revise o SQL, gere o
client e aplique primeiro a um banco de teste isolado.

```powershell
$env:DATABASE_URL="<BANCO_DE_TESTE_ISOLADO>"
npm run prisma:generate
npx prisma validate --schema prisma/schema.prisma
npx prisma migrate deploy --schema prisma/schema.prisma
```

## Freshness imediatamente antes do transporte

Defaults:

- TTL de validação: 30 minutos;
- margem de expiração: 10 minutos;
- mudança de preço invalida o snapshot;
- inactive, expired, expiring ou stale nunca é anunciado.

Antes do transporte, uma Publication `SCHEDULED` com snapshot é reavaliada. Um
cupom persistido e ainda fresh pode substituir o anterior; sem substituto, a
mensagem é regenerada deterministicamente sem cupom. A política do canal é
reavaliada. Se a oferta deixar de ser elegível, o transporte não é chamado e o
código é `COUPON_REFRESH_MADE_OFFER_INELIGIBLE`. Falha de refresh nunca estende
validade nem autoriza cupom stale.

Telegram e WhatsApp usam a mesma decisão estruturada da Publication. Coupon
Intelligence nunca troca `trackingUrlSnapshot`: ofertas com
`INTERNAL_REDIRECT` conservam `https://PUBLIC_HOST/go/<slug>`, sem fallback para
Product URL ou destino afiliado. A estratégia legada
`DIRECT_AFFILIATE_LINK` do Mercado Livre permanece inalterada quando as flags
estão desligadas, por compatibilidade. O copywriter de IA continua limitado ao
headline: fatos do cupom são renderizados pelo builder determinístico em NFC.

## Ranking

O ranking atual foi preservado. Com a flag desligada, o score final é exatamente
o base score e `couponBonus=0`. Com a flag ligada, somente cupom `CONFIRMED` com
percentual efetivo calculado recebe bônus, limitado por
`COUPON_RANKING_MAX_BONUS` e pelo teto 100. Cupom conditional, expired ou stale
recebe zero. O scorer exige `couponFresh=true` explicitamente; ausência dessa
prova mantém o bônus em zero.

## Configuração

```dotenv
COUPON_INTELLIGENCE_ENABLED="false"
SHOPEE_COUPON_DISCOVERY_ENABLED="false"
MERCADOLIVRE_COUPON_DISCOVERY_ENABLED="false"
COUPON_RANKING_ENABLED="false"
COUPON_REFRESH_TTL_MINUTES="30"
COUPON_EXPIRY_SAFETY_MINUTES="10"
COUPON_DISCOVERY_MAX_PER_CYCLE="24"
COUPON_RANKING_MAX_BONUS="8"
```

Valores vazios ou inválidos retornam aos limites seguros. Ativar discovery de
uma marketplace não torna um provider sem contrato oficial suportado.

## CLI e observabilidade

```powershell
npm run coupons:status
npm run coupons:preview -- --offer-id <Offer.id>
npm run coupons:refresh -- --offer-id <Offer.id> --confirm-refresh
```

`status` e `preview` são read-only. Preview mostra apenas chave, presença de
código, source, aplicabilidade, motivo, preço efetivo e validade. Sem
`--confirm-refresh`, refresh falha antes de ler a Offer ou chamar provider. Os
metadados persistidos removem chaves que possam conter token, secret, cookie,
authorization, password ou credential.

O dashboard `/cupons` mostra benefício, aplicabilidade, preço efetivo,
fresh/stale, validade e source. Offers mostram o cupom selecionado; Publications
mostram seu snapshot. Os painéis das integrações deixam claro que discovery não
é suportado pelo contrato atual sem tratar isso como falha geral.

Os ciclos expõem `couponCandidates`, `couponResolved`, `couponConfirmed`,
`couponConditional`, `couponRejected`, `couponExpired`, `couponRefreshCalls` e
`couponRefreshFailures`; os mesmos contadores são propagados ao ciclo de
produção Shopee.

## Ativação futura e canário guiado

Uma fonte futura só pode ser ativada após confirmar documentação oficial,
autenticação, campos, escopos e limites. Implemente o provider, fixtures do
contrato real e sanitização; mantenha ranking e publicação independentes do
client específico. Depois: migration em banco de teste, testes focados, regressão
global, preview de uma Offer fictícia, refresh explicitamente confirmado e só
então um canário externo separado. Nunca use scraping ou navegador para obter
cupons.
