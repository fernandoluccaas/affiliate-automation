# Descoberta multicategoria balanceada

## Sessão e arquitetura

Uma sessão multicategoria é o `ImportJob` `MERCADOLIVRE_BEST_SELLERS` criado pelo `MercadoLivreDiscoveryService`. Dashboard, CLI e worker reutilizam esse serviço; não existe um segundo coletor nem outro timer. A descoberta continua usando categorias-folha e `/highlights`, resolve `ITEM`, `PRODUCT` e `USER_PRODUCT`, gera ou reutiliza o link `meli.la` e executa ingestão, validação e score determinísticos.

O `sourceCategoryId`, ranking e estratégia permanecem no `Offer` e no snapshot da `Publication`. Quando o mesmo produto aparece em várias categorias, a sessão guarda os IDs de origem no item do job, escolhe a categoria primária pela prioridade e ordem configuradas e usa a identidade existente `marketplace + externalProductId`. Mudança apenas de ranking ou categoria não altera o fingerprint comercial e não cria versão.

## Configuração segura

O recurso exige simultaneamente a flag de ambiente e a opção persistida no painel:

```env
MULTI_CATEGORY_DISCOVERY_ENABLED="false"
MULTI_CATEGORY_MIN_OFFERS_PER_CATEGORY="1"
MULTI_CATEGORY_MAX_OFFERS_PER_CATEGORY="2"
MULTI_CATEGORY_MAX_TOTAL_PER_SESSION="12"
MULTI_CATEGORY_SELECTION_MODE="ROUND_ROBIN"
MULTI_CATEGORY_ALLOW_CATEGORY_BACKFILL="false"
```

Valores inválidos retornam aos limites seguros. O painel Mercado Livre permite manter qualquer categoria-folha oficial, habilitá-la, atribuir prioridade e sobrescrever mínimo/máximo. O ID oficial é persistido e duplicados são normalizados.

## Seleção, cotas e backfill

Somente a versão ingerida que esteja pronta, agendada ou publicada, com score suficiente e link afiliado válido entra na seleção. Validação do canal, janela, limite diário, intervalo e repetição continuam no scheduler.

A ordenação dentro da categoria é determinística: score, posição no ranking, desconto confirmado, completude e ID. A primeira rodada tenta cumprir o mínimo de cada categoria. Se todas cumprirem, novas rodadas avançam até o máximo. Se alguma não cumprir, as demais não ocupam a cota ausente, salvo quando o backfill estiver explicitamente habilitado; mesmo assim, nenhuma categoria excede seu próprio máximo e a sessão nunca excede o máximo total.

O resultado é intercalado em round robin. Prioridade altera apenas a categoria que inicia cada rodada. Uma falha isolada gera resultado `PARTIAL` e não cancela as demais categorias.

## Links afiliados

A fase preserva `MercadoLivreAffiliateLinkService`, a sessão autorizada e o reuso de links existentes. Com a sessão `CONNECTED`, a descoberta solicita links reais `meli.la` antes da ingestão. Sessão ausente ou expirada não fabrica link nem usa `productUrl`: a oferta permanece `READY_FOR_AFFILIATE_LINK` e a importação manual continua disponível.

## Publicação gradual

Os IDs escolhidos são passados ao scheduler como ordem preferencial. O scheduler continua criando no máximo o que a capacidade atual de cada canal admite, respeitando timezone, janela, intervalo, limite diário, marketplace, score e repetição. Ofertas antigas elegíveis continuam como fallback.

Telegram mantém o publicador existente. Grupos WhatsApp recebem somente planejamento e snapshot; o worker não abre Playwright e o dispatch continua local, explícito e unitário.

## CLI e preview

Comandos somente leitura:

```bash
npm run discovery:multi-category:status
npm run discovery:multi-category:preflight
npm run discovery:multi-category:preview
npm run discovery:multi-category:run -- --dry-run
```

`preview` e `--dry-run` usam o estado atual do banco, não chamam o Mercado Livre e não escrevem `Product`, `Offer`, `Publication` ou job. Uma descoberta real exige o argumento explícito:

Para uma reprodução totalmente isolada do banco, defina temporariamente `MULTI_CATEGORY_DISCOVERY_FIXTURE_MODE=true`; os quatro comandos usam `packages/marketplace-discovery/fixtures/multi-category-sanitized.json`, recusam execução confirmada e informam `externalCalls: false` e `writes: false`.

```bash
npm run discovery:multi-category:run -- --confirm-discovery
```

Esse comando pode usar as integrações oficiais configuradas e deve ser executado apenas por um administrador consciente dos efeitos.

## Status, auditoria e troubleshooting

`ops:status`, `ops:audit-state`, `/operacoes` e a página Mercado Livre mostram o modo, a última sessão, cotas, duplicados e distribuição. Achados de sessão abandonada, configuração vazia, cota não atendida, duplicidade e sessão afiliada expirada são somente leitura e nunca corrigidos automaticamente.

- `MULTI_CATEGORY_DISCOVERY_DISABLED`: habilite a flag e a opção no painel.
- `NO_CATEGORIES_CONFIGURED`: adicione categorias-folha pela integração oficial.
- `CATEGORY_QUOTA_NOT_MET`: não havia candidatos elegíveis suficientes; revise score, link e políticas.
- `DISCOVERY_LOCK_LOST`: o ownership Redis foi perdido; a execução é interrompida e não deve ser retomada como a mesma sessão.
- links pendentes: renove manualmente a sessão afiliada autorizada ou use o lote manual.

Para desabilitar completamente, mantenha `MULTI_CATEGORY_DISCOVERY_ENABLED="false"`. A descoberta legada permanece com seu comportamento anterior e nenhuma configuração de canal é alterada.
