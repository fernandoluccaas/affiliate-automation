# Shopee Affiliate — Datafeed and Open API discovery

## Escopo das Fases 6A.2 e 6A.3

A conta está aprovada no Programa de Afiliados Shopee e disponibiliza Datafeeds
oficiais diários. A Fase 6A.2 implementa leitura local, descoberta determinística
e preview. A Fase 6A.3 adiciona a confirmação operacional e a geração automática
de shortlinks pelo contrato GraphQL oficial `generateShortLink`.

Não há scraping, login automatizado, browser ou download remoto do feed. Somente
uma confirmação explícita pode criar `Product`, versões de `Offer`,
`ImportJob` e `ImportJobItem`. Um `AffiliateLink` só é criado depois da geração
Open API ou da validação do shortlink manual. O fluxo pode terminar em
`READY_FOR_AFFILIATE_LINK` ou `READY_TO_PUBLISH`: nunca cria `Publication` nem
envia mensagens.

## Modos

- `OFF`: padrão seguro; nenhum Datafeed é processado.
- `DATAFEED`: inspect, preview e importação confirmada; links permanecem pendentes.
- `OPEN_API`: cliente de shortlink pronto apenas com App ID e Secret no servidor.
- `HYBRID`: Datafeed operacional seguido de geração automática pela Open API.

Configuração de exemplo:

```dotenv
SHOPEE_AFFILIATE_ENABLED="false"
SHOPEE_AFFILIATE_MODE="OFF"
SHOPEE_OPEN_API_APP_ID=""
SHOPEE_OPEN_API_SECRET=""
SHOPEE_OPEN_API_TIMEOUT_MS="10000"
SHOPEE_OPEN_API_RATE_LIMIT_PER_HOUR="1000"
SHOPEE_DATAFEED_LINKS_VERIFIED="false"
SHOPEE_DATAFEED_MAX_FILE_BYTES="536870912"
SHOPEE_DATAFEED_MAX_TRACKED_ITEMS="2000000"
SHOPEE_RECENT_SELECTION_WINDOW_DAYS="7"
SHOPEE_MAX_PER_SHOP_PER_SESSION="2"
```

Valores ausentes ou desconhecidos falham de forma fechada. O projeto nunca
altera `.env` automaticamente.

## Schemas oficiais reconhecidos

`Shopee Oficial BR - 2022`:

```text
shop_rating,itemid,sale_price,item_rating,global_category3,cb_option,
discount_percentage,global_catid2,price,description,title,global_category1,
image_link_3,global_catid1,global_catid3,like,condition,global_category2,
model_ids,image_link,model_names,shop_name,product_link,product_short link
```

`Shopee Brasil - 2022`:

```text
image_link,itemid,price,global_category1,description,global_category2,
global_item_attributes,item_rating,sale_price,global_catid2,
discount_percentage,image_link_3,title,global_catid1,product_link,
product_short link
```

O cabeçalho é comparado exatamente, após a remoção exclusiva do BOM. Em
particular, `product_short link` possui um espaço literal. A normalização para
nomes TypeScript acontece somente depois da identificação do schema.

## Streaming e recursos

O pacote `@affiliate/shopee-affiliate` usa `createReadStream` com chunks de 64
KiB e `csv-parse`. Quoted fields, vírgulas, CRLF/LF, descrições multiline, campos
vazios, BOM e EOF são tratados pelo parser streaming com backpressure.

O checksum SHA-256 é calculado incrementalmente. Arquivos não são lidos por
`readFile`/`readFileSync` e o teste de contrato impede essa regressão. Um lock
local por fingerprint (caminho, tamanho e mtime) evita processamento concorrente
do mesmo arquivo.

No preview, registros normalizados são distribuídos em 64 buckets temporários
por `itemid`. Cada bucket é deduplicado isoladamente e descartado ao final. Isso
evita um array com o feed inteiro e mantém o uso de memória proporcional a um
bucket, não ao arquivo de aproximadamente 198 MB.

## Normalização e deduplicação

A identidade é `itemid`. Campos ausentes permanecem `null`; não são inventados
comissão, quantidade vendida, estoque ou frete. O modelo explicita
`commissionAvailable=false` e `salesCountAvailable=false`.

Quando o mesmo item aparece nos dois feeds:

1. vence o registro com maior completude válida;
2. em empate, `OFFICIAL_BR` tem prioridade configurada explicitamente;
3. o desempate final usa uma chave textual estável;
4. campos vazios podem ser preenchidos pelo outro registro;
5. conflitos de preço, desconto e rating são contabilizados;
6. `sources[]` preserva a proveniência.

O nome “Shopee Oficial BR” é somente a identificação do feed e não classifica
automaticamente a loja como oficial.

## Links, Open API e gate de atribuição

`product_link` vira `sourceProductUrl`. `product_short link` vira
`candidateAffiliateUrl`. Ele só pode virar `verifiedAffiliateUrl` quando
`SHOPEE_DATAFEED_LINKS_VERIFIED=true` for habilitado explicitamente após a
confirmação de atribuição.

Com o padrão `false`, parsing, inspeção, ranking e preview continuam funcionando,
mas os links candidatos aparecem como `NÃO VERIFICADO` e nunca são promovidos a
links de afiliado. A Fase 6A.2 permanece disponível para preview. Na Fase 6A.3,
uma confirmação explícita permite que `DATAFEED` persista os vencedores ainda
pendentes; `HYBRID` persiste primeiro a oferta pendente e envia somente a URL de
produto validada à operação `generateShortLink`.

No ambiente operacional atual, sem App ID e Secret, `OPEN_API` e `HYBRID`
permanecem fail-closed. O modo `DATAFEED` não exige credenciais, não instancia o
cliente externo e importa somente os vencedores como
`READY_FOR_AFFILIATE_LINK`. O `product_short link` com host `shope.ee` jamais é
promovido para `AffiliateLink`.

O endpoint de produção é fixo em
`https://open-api.affiliate.shopee.com.br/graphql`. O corpo é serializado uma
vez e a mesma sequência de bytes é usada em
`SHA256(AppId + Timestamp + Payload + Secret)` e no POST. O timestamp usa
segundos Unix; o timeout padrão é 10 segundos e o limitador local padrão é
1.000 chamadas/hora, sempre limitado ao teto oficial de 8.000/hora. Erros
GraphQL `10000`, `10010`, `10020`, `10030` e `11000` são convertidos em códigos
operacionais sem payload, header ou segredo.

Contrato conferido no [Open API Explorer oficial da Shopee Brasil](https://open-api.affiliate.shopee.com.br/explorer/v2),
sem informar credenciais ao Explorer. A implementação usa somente o contrato
`generateShortLink` descrito acima; nenhuma operação não documentada foi criada.
Por compatibilidade específica com o endpoint brasileiro, o payload segue a
mutation anônima literal produzida pelo Explorer V2, com `originUrl` e SubIds
validados e escapados, seleção de `shortLink` e `longLink` e envelope JSON
contendo somente `query`. O formato anterior com `operationName` e `variables`
foi rejeitado por esse endpoint com o código oficial `10010`; isso não implica
uma limitação geral do padrão GraphQL. `longLink` é reconhecido na resposta,
mas somente o `shortLink` validado é usado como destino afiliado.

A URL de origem deve ser HTTPS, pertencer a `shopee.com.br` ou subdomínio
legítimo, não conter credenciais/porta e carregar o mesmo `itemId` do Datafeed.
`shope.ee`, `/go` e domínios semelhantes são rejeitados. A resposta automática
aceita apenas `https://s.shopee.com.br/...`.

O parser de origem reconhece estritamente os formatos oficiais
`<slug>-i.<shopId>.<itemId>`, `/product/<shopId>/<itemId>` e
`/opaanlp/<shopId>/<itemId>`, além dos parâmetros legados `itemId` e `item_id`.
No formato `opaanlp`, os dois IDs devem ser numéricos e não são aceitos
segmentos adicionais ambíguos.

Até cinco SubIds opcionais são aceitos, com no máximo 64 caracteres cada. O
contrato observado da Open API brasileira aceita somente caracteres
alfanuméricos (`^[A-Za-z0-9]+$`). O sistema usa identificadores não sensíveis
como `sourcedatafeed`, `phase6a3` e `retry`. Valores vazios, espaços,
underscore, hífen, ponto, PII implícita ou mais de cinco entradas são recusados
localmente antes da chamada externa. Valores fornecidos externamente não são
normalizados silenciosamente: um valor inválido precisa ser corrigido na origem.

## Categorias e filtros

O catálogo central contém:

- Celulares: `Mobile & Gadgets > Mobile Phones`;
- Casa: `Home & Living`;
- Moda: `Women Clothes`, `Men Clothes` ou `Fashion Accessories`;
- Relógios: `Watches`;
- Automotivo: `Spare Parts and Accessories for Vehicles`;
- Eletrodomésticos: `Home Appliances`.

Cada regra suporta `enabled`, `priority`, `minPerCategory` e `maxPerCategory`.
Os filtros cobrem preço, desconto, item rating, shop rating quando disponível,
condição, cross-border, palavras proibidas, imagem e URL. Defaults de preview:
desconto mínimo 20%, rating mínimo 4,7, mínimo 1, máximo 2, total 12, round robin
e backfill desativado. Isso não modifica regras comerciais globais.

## Ranking e round robin

O score não usa IA. O breakdown inclui desconto, item rating, shop rating,
likes, completude e penalidade de diversidade. Componentes ausentes, como
`shop_rating` no feed menor, são removidos do denominador em vez de receber nota
zero. Comissão e vendas não participam porque não existem nos Datafeeds atuais.

Após ordenar cada categoria por score e desempates estáveis, o round robin
seleciona o primeiro candidato de cada categoria antes do segundo. Sem backfill,
uma categoria sem mínimo impede a segunda rodada; com backfill, as demais ainda
podem avançar até o máximo individual. O total nunca ultrapassa 12 por padrão.

O componente de desconto satura em 60%; valores extremos não recebem peso
adicional. A seleção também exclui itens escolhidos no período recente
configurável (sete dias por padrão) e limita a duas ofertas da mesma loja por
sessão. Loja ausente permanece neutra. Esses limites são determinísticos e não
inventam histórico externo de preços.

## CLI

Ative `DATAFEED` no ambiente e informe caminhos explicitamente:

```powershell
npm run shopee:datafeed:status
npm run shopee:datafeed:inspect -- --file "C:\caminho\feed.csv"
npm run shopee:datafeed:preview -- --file "C:\caminho\feed1.csv" --file "C:\caminho\feed2.csv"
npm run shopee:datafeed:import -- --file "C:\caminho\feed.csv"
npm run shopee:datafeed:import -- --file "C:\caminho\feed.csv" --confirm-import
```

`inspect` mostra schema, nome, tamanho, checksum, linhas, categorias, URLs,
shortlinks candidatos, duração e pico aproximado de heap. `preview` mostra
somente vencedores e métricas sanitizadas. Descrições e dumps de URLs não são
impressos em lote. Sem `--confirm-import`, o comando de importação também é
preview-only e não grava estado.

O dashboard em `/integracoes/shopee` oferece as mesmas operações com feedback
inline, pending localizado, prevenção de duplo clique e preservação de tab,
scroll e formulário. O arquivo continua no servidor; não há upload de 198 MB
para a memória do browser.

## Descoberta oficial por Item Feed — contrato ativo

A Fase 6A.5b ativa o adapter produtivo confirmado no Explorer V2 oficial para
o ambiente brasileiro. A descoberta massiva usa exclusivamente:

```text
listItemFeeds(feedMode: FULL)
  -> selecionar a versão atual pelo referenceId estável
  -> getItemFeedData(datafeedId, offset, limit)
  -> columns JSON
  -> normalizador comercial compartilhado com o CSV
  -> filtros, ranking, pools limitados e round robin
```

`listItemFeeds` retorna `datafeedId`, `referenceId`, `datafeedName`,
`description`, `totalCount`, `date` e `feedMode`. O `referenceId` é a identidade
estável configurável; o `datafeedId` identifica uma versão datada e é sempre
usado exatamente como retornado pela API. O sistema nunca constrói o
`datafeedId` por concatenação. Os dois feeds FULL disponíveis para uma conta
podem ser processados sequencialmente na mesma sessão, sem hardcode de nomes ou
IDs e com deduplicação global por `itemId`.

`getItemFeedData` usa paginação por offset: começa em `0`, solicita de 1 a 500
linhas e avança pelo progresso real (`offset + rows.length`). Cada página
revalida `totalCount`: quando o próximo offset atinge esse limite, a leitura
termina mesmo que a Shopee ainda informe `hasMore=true` na última página cheia.
A página terminal vazia (`offset === totalCount`, zero linhas e
`hasMore=false`) também conclui normalmente. `hasMore=false` antes do limite,
offset repetido/regressivo, ausência de progresso, linhas além do limite ou
`totalCount` incompatível continuam bloqueados. Uma variação coerente de
`totalCount` entre páginas é aceita sem criar snapshot ou ultrapassar o limite.
Preview parcial por `maxPages`/`maxItems` conserva métricas, produz zero
escritas e encerra a CLI com sucesso; outras falhas parciais continuam com exit
code não zero. Import exige `complete=true` e nunca persiste vencedores de um
catálogo truncado.

Em FULL, `updateType` deve ser `null`. DELTA está reconhecido no contrato, mas
fica bloqueado por `SHOPEE_REMOTE_DISCOVERY_DELTA_NOT_SUPPORTED`; NEW, UPDATE e
DELETE não são aplicados nesta fase. `productOfferV2` também foi confirmado
como uma operação separada, com paginação page/`scrollId` de curta duração e
`offerLink` em `s.shopee.com.br`, mas não integra o discovery. Ele fica reservado
para enrichment futuro de comissão/vendas. `generateShortLink` permanece o
único caminho principal de AffiliateLink.

Contrato registrado, sem chamada operacional: `productOfferV2` aceita
`listType` (`0 ALL`, `1 HIGHEST_COMMISSION`, `2 TOP_PERFORMING`,
`3 LANDING_CATEGORY`, `4 DETAIL_CATEGORY`, `5 DETAIL_SHOP`,
`6 DETAIL_COLLECTION`), além de `matchId`, `keyword`, `sortType`, `page`,
`limit`, `itemId`, `shopId`, `productCatId`, `isAMSOffer` e `isKeySeller`. Os
sorts confirmados são relevância, vendidos, preço decrescente/crescente e
comissão. Os nodes podem fornecer item/shop, nomes, preços, sales, ratings,
categorias, taxas/comissão, período, imagem, `productLink` e `offerLink`;
`pageInfo` usa page/limit/hasNextPage/`scrollId`. O cursor começa vazio, dura
aproximadamente 30 segundos e, se expirar, exigirá reinício da consulta. Esse
contrato não é confundido com o offset do Item Feed e não foi implementado.

O campo `columns` é uma string JSON com os nomes já conhecidos no CSV, como
`itemid`, `title`, `price`, `sale_price`, `discount_percentage`,
`item_rating`, categorias, imagens e `product_link`. O schema externo é
validado com Zod; números em string passam pelo normalizador explícito e IDs
continuam strings. Campos adicionais são tolerados sem influenciar regras.
`global_item_attributes` não participa do ranking. O `product_short link`
universal recebido no feed não é promovido a AffiliateLink nem usado em
`/go/[slug]`; ele é descartado do modelo afiliado e o tracking oficial é criado
posteriormente por `generateShortLink`.

O consumo mantém memória limitada: a página atual é normalizada e liberada,
enquanto ficam residentes somente o conjunto compacto de IDs vistos e pools de
até 100 candidatos por categoria. Filtros, seis categorias, score,
`recentSelectionWindowDays`, máximo por loja, máximo de 12 vencedores e round
robin são os mesmos do CSV. Comissões e vendas não foram adicionadas ao score.

Configuração segura:

```dotenv
SHOPEE_DISCOVERY_SOURCE="LOCAL_FILE"
SHOPEE_AUTOMATED_DISCOVERY_ENABLED="false"
SHOPEE_AUTOMATED_DISCOVERY_INTERVAL_HOURS="24"
SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS=""
SHOPEE_REMOTE_DISCOVERY_PAGE_SIZE="500"
SHOPEE_REMOTE_DISCOVERY_MAX_PAGES="10"
SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS="10000"
SHOPEE_REMOTE_DISCOVERY_FEED_IDS="" # legado/deprecated
```

O default continua `LOCAL_FILE` e o auto-run continua desligado. A execução
automática de escrita exige uma allowlist não vazia de `referenceId`; nenhum
feed futuro é aceito implicitamente. A flag `SHOPEE_REMOTE_DISCOVERY_FEED_IDS`
preserva compatibilidade somente para seleção exata de versões antigas e não
deve ser confundida com identidade estável. Os limites aceitam configuração
de pelo menos 250 páginas e 120.000 itens, mantendo defaults conservadores.
Todas as páginas passam pelo mesmo timeout, rate limiter e transporte assinado,
com concorrência efetiva 1. Apenas falhas transitórias de conexão, timeout ou
5xx recebem uma segunda tentativa curta; auth, assinatura, GraphQL validation,
schema, feed inexistente e rate limit não entram em retry local.

Comandos operacionais:

```powershell
npm run shopee:discovery:remote:status
npm run shopee:feeds:list -- --confirm-live-call
npm run shopee:discovery:remote:preview -- --reference-id <REFERENCE_ID> --confirm-live-call
npm run shopee:discovery:remote:preview -- --feed <DATAFEED_ID> --page-size 3 --max-pages 1 --max-items 3 --confirm-live-call
npm run shopee:discovery:remote:run -- --reference-id <REFERENCE_ID> --confirm-live-call --confirm-import
```

Sem `--confirm-live-call`, há zero requests. O run requer ainda
`--confirm-import`, lock Redis com ownership e catálogo completo. Preview gera
zero `Product`, `Offer`, `AffiliateLink` e `Publication`. O import reutiliza o
pipeline versionado e pode executar auto-link somente se
`SHOPEE_AUTO_LINK_AFTER_IMPORT=true` e HYBRID estiver pronto. Em qualquer caso,
esta fase cria zero Publications e envia zero mensagens.

O dashboard consulta feeds apenas por clique autenticado. Ele mantém pending
localizado, bloqueio de duplo clique, tab e scroll, e mostra somente metadata e
métricas sanitizadas. Nenhuma chamada ocorre no carregamento da página.

## Descoberta agendada — Fase 6A.6

A execução manual continua disponível e exige `--confirm-live-call` e
`--confirm-import`. A execução agendada reutiliza o componente `discovery` do
worker contínuo; não cria timer, processo ou scheduler paralelo. O componente
do worker pode acordar em sua cadência normal, mas o serviço Shopee só fica due
depois do intervalo próprio, cujo default é 24 horas:

```dotenv
SHOPEE_AUTOMATED_DISCOVERY_ENABLED="false"
SHOPEE_AUTOMATED_DISCOVERY_INTERVAL_HOURS="24"
SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS="reference-id-estavel-1,reference-id-estavel-2"
```

`autoRunReady` exige simultaneamente integração habilitada, modo Open API
compatível, credenciais configuradas, source `OPEN_API_FEED`, contrato
`OFFICIAL_V2_FULL`, flag de automação igual a `true`, intervalo válido, pelo
menos um `referenceId` estável e um backend Redis configurado. O status seguro
não sonda Redis nem adquire lock: ele informa `CONFIGURED_NOT_PROBED`, e o tick
confirma a disponibilidade real de modo fail-closed ao adquirir o lock. IDs
reais de conta nunca são defaults do repositório. A cada execução,
`listItemFeeds(FULL)` resolve o `datafeedId` atual
de cada referência; IDs datados não são usados como identidade persistente.

O último tick é persistido como `AutomationRun` com o nome
`shopee-scheduled-discovery`. A decisão due usa `startedAt + intervalo`, então
reiniciar o worker minutos depois não dispara novamente a leitura do catálogo.
O idempotency key por janela, a rechecagem de due depois do lock e o lock Redis
`shopee:remote-discovery` impedem ticks duplicados e workers concorrentes. O lock
tem TTL defensivo de uma hora e é liberado em sucesso, partial, falha ou
exceção.

O scheduler carrega os item IDs selecionados nos últimos sete dias pelo mesmo
`ImportJobItem` usado no fluxo manual. Somente um preview com `complete=true`
chega ao import. Limite de páginas/itens, schema drift, paginação inconsistente,
auth, GraphQL, rate limit ou timeout deixam o run como PARTIAL/FAILED, com zero
import e zero auto-link. Para os dois feeds grandes, o operador deve configurar
limites suficientes, por exemplo 500 itens por página, ao menos 220 páginas e
110.000 itens; os hard caps permanecem 500 páginas e 500.000 itens.

Após import completo, `SHOPEE_AUTO_LINK_AFTER_IMPORT=false` mantém as ofertas em
`READY_FOR_AFFILIATE_LINK`. Com `true`, o pipeline já existente chama
`generateShortLink`, isola falhas individuais e pode levar as ofertas válidas a
`READY_TO_PUBLISH`. Esse é o boundary final: o planejador do worker exclui
explicitamente marketplace Shopee, portanto esta fase cria zero `Publication`
e envia zero Telegram/WhatsApp.

Status seguro, sem API e sem escrita:

```powershell
npm run shopee:discovery:auto:status
```

O status mostra enabled/ready/due, intervalo, última e próxima execução, feeds,
itens, seleção, import, links e erro sanitizado. Para uma validação real futura,
o operador configura `.env`, verifica primeiro esse status e inicia o worker
operacional controlado. Os comandos manuais continuam exigindo suas duas
confirmações; `--help` nunca passa pelo gate live.

### Registro histórico — decisão fail-closed da Fase 6A.5 (substituída)

O texto abaixo documenta por que a fase anterior permaneceu fechada antes de o
contrato ser confirmado. O estado operacional atual é o descrito acima.

A Fase 6A.5 auditou o cliente autenticado, os testes de assinatura, o smoke de
`generateShortLink`, o histórico Git e o Explorer V2 oficial. O único contrato
completo preservado no repositório é a mutation `generateShortLink`: payload
literal, assinatura, headers e resposta já foram validados nas fases anteriores.

As operações `listItemFeeds`, `getItemFeedData`, `productOfferV2`,
`shopeeOfferV2` e `shopOfferV2` foram consideradas como possíveis fontes. O
repositório, entretanto, não contém os tipos GraphQL, argumentos, campos,
paginação ou response shape oficiais dessas operações. O Explorer público não
expôs esse conteúdo sem a sessão do proprietário. Portanto, nenhuma delas foi
escolhida como query de produção e nenhum GraphQL foi inferido pelo nome.

A decisão é manter duas sources explícitas:

```text
LOCAL_FILE     contrato comprovado, funcional e default
OPEN_API_FEED  infraestrutura pronta, adaptador de produção fail-closed
```

`UnavailableShopeeRemoteFeedClient` encerra com
`SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE` antes do transporte. Logo, mesmo
com credenciais e `--confirm-live-call`, a versão atual faz zero requests de
feed. O status público é `WAITING_FOR_OFFICIAL_CONTRACT`. Para liberar a source
remota será necessário registrar, a partir do Explorer oficial autenticado:

1. operation name e query exatos;
2. tipos e valores das variables;
3. campos obrigatórios e opcionais da resposta;
4. mecanismo e término da paginação;
5. duração e semântica do cursor/`scrollId`, caso exista;
6. IDs/metadata estáveis dos feeds;
7. limites e códigos de erro da operação para o ambiente brasileiro.

Somente então um adapter poderá ser conectado ao cliente HTTP e à assinatura
existentes. Não será criado um segundo transporte ou mecanismo de rate limit.

### Source, paginação e memória

A fronteira `ShopeeRemoteFeedClient` fornece lista sanitizada de feeds e páginas
normalizadas ao pipeline interno. O cursor é opaco: a infraestrutura não assume
offset, número de página nem duração. Cursores repetidos são rejeitados como
`SHOPEE_REMOTE_DISCOVERY_CURSOR_LOOP`. Feed ID é obrigatório e validado; nenhum
feed é escolhido pelo nome ou pela primeira posição.

Cada página converge para o mesmo `ShopeeDatafeedProduct` usado pelo CSV. A
validação exige identidade numérica, preço, categoria, imagem oficial e Product
URL contendo o mesmo `itemId`; campos opcionais permanecem `null`. Comissão e
sales count continuam indisponíveis e não entram no score. A proveniência é
`OPEN_API_FEED`, e `itemId` deduplica páginas e futuras sources.

O processamento é limitado e bounded: produtos são mantidos somente até o
limite explícito da execução; ranking, filtros, recent selection, máximo por
loja, seis categorias e round robin reutilizam as funções da source local. O
resultado sanitizado contém source, feed, páginas, itens recebidos/normalizados,
rejeições, duplicados, elegíveis, selecionados, requests e duração. Não contém
credentials, headers, assinatura ou payload bruto.

Defaults conservadores:

```dotenv
SHOPEE_DISCOVERY_SOURCE="LOCAL_FILE"
SHOPEE_AUTOMATED_DISCOVERY_ENABLED="false"
SHOPEE_REMOTE_DISCOVERY_MAX_PAGES="10"
SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS="10000"
SHOPEE_REMOTE_DISCOVERY_FEED_IDS=""
```

Configuração ausente preserva o Datafeed local. Source/limite/feed ID inválido
falha fechado. Não existe busca automática em Downloads nem fallback silencioso
para um arquivo encontrado no disco.

### Preview, import e lock

O one-shot `runShopeeAutomatedDiscovery` separa os efeitos:

```text
remote pages -> validação -> dedup -> filtros/ranking compartilhados
             -> round robin (máximo 12) -> preview
             -> import confirmado -> auto-link opcional
```

Preview nunca escreve `Product`, `Offer`, `AffiliateLink` ou `Publication`,
mesmo se auto-link estiver habilitado. Import exige simultaneamente chamada live
e escrita confirmadas. Antes de qualquer request de uma execução com escrita, o
pipeline exige o lock Redis com ownership `shopee:remote-discovery`; lock ocupado
ou Redis indisponível termina com zero requests. O lock é sempre liberado.

O import reutiliza `persistShopeeOperationalWinners`, a mesma persistência
versionada do Datafeed local, seus advisory locks por `itemId`, ImportJob,
idempotência e isolamento por winner. O checksum remoto combina source, feed e
o fingerprint comercial determinístico dos winners; payload bruto nunca é
persistido. A flag
`SHOPEE_AUTO_LINK_AFTER_IMPORT` permanece `false` por default. Quando futuramente
habilitada em `HYBRID`, o bulk da Fase 6A.4 roda depois do commit; falha de link
não desfaz a importação.

Erros transitórios de transporte admitem no máximo duas tentativas. Rate limit,
auth, assinatura, GraphQL validation, input e schema mismatch não entram em
retry infinito. Rate limit depois de páginas válidas preserva um preview parcial
com zero writes; resposta incompatível falha fechado como
`SHOPEE_OPEN_API_SCHEMA_MISMATCH`.

### CLI e primeiro smoke planejado

```powershell
npm run shopee:discovery:remote:status
npm run shopee:feeds:list -- --confirm-live-call
npm run shopee:discovery:remote:preview -- --feed <feed-id> --confirm-live-call
npm run shopee:discovery:remote:run -- --feed <feed-id> --confirm-live-call --confirm-import
```

Sem `--confirm-live-call`, todos retornam zero requests e zero writes. `run`
também exige `--confirm-import`; uma confirmação não substitui a outra. Enquanto
o contrato continuar indisponível, até os comandos confirmados retornam o erro
de contrato antes de HTTP. O primeiro smoke real futuro será somente a listagem
read-only dos feeds. Preview remoto e import serão liberados em etapas separadas
após validar a resposta real.

O dashboard mostra a source configurada, prontidão, limites e a lacuna do
contrato. Os controles remotos ficam desabilitados e não executam requests no
load. `LOCAL_FILE`, inspect, preview e import existentes permanecem disponíveis.
Nenhum fluxo desta fase cria `Publication`, chama Telegram/WhatsApp ou inicia
worker, browser ou scheduler.

## Persistência, idempotência e fallback

As interfaces `ShopeeOfferProvider`, `ShopeeAffiliateLinkProvider` e
`ShopeeConversionProvider` mantêm descoberta, links e conversões separadas. O
checksum da sessão combina os checksums dos arquivos; reimportações dos mesmos
arquivos não duplicam estado, mesmo que a janela de repetição altere a seleção.
Cada item usa lock consultivo PostgreSQL. Antes de chamar a API,
o serviço procura um `AffiliateLink` ativo para a mesma origem e hash dos SubIds.

Sucesso gera a versão comercial com link, `AffiliateLink.destination` e, depois
de reexecutar validação e score mínimo, status `READY_TO_PUBLISH`. API desativada,
credenciais ausentes ou erro mantém `READY_FOR_AFFILIATE_LINK` e registra somente
código sanitizado no item do job. O dashboard permite retry explícito e fallback
manual. O shortlink manual é validado e seus redirects são seguidos manualmente,
limitados a hosts oficiais, até confirmar o mesmo `itemId`. Somente HTTPS e o
host exato `s.shopee.com.br`, sem credenciais ou porta, são aceitos na entrada.
Cada hop é limitado, validado e resolvido por DNS; localhost, redes privadas,
link-local, endereços especiais IPv4/IPv6, loops e hosts fora da allowlist são
rejeitados. O resolvedor não lê HTML nem usa navegador.

O dashboard consulta apenas a versão comercial mais recente de cada item. As
Server Actions retornam um DTO sanitizado com as contagens e ofertas pendentes;
o Client Island atualiza o estado local, preservando tab, formulário e scroll,
sem `revalidatePath` ou `router.refresh`.

O redirect `/go/[slug]` continua consultando exclusivamente
`AffiliateLink.destination`; URL do produto, candidato do Datafeed e `shope.ee`
não são fallbacks de tracking.

## Geração automatizada de links

O fluxo padrão permanece fail-closed:

```text
DATAFEED -> discovery -> import -> READY_FOR_AFFILIATE_LINK
```

Em modo `HYBRID`, a aba **Links** permite confirmar **Gerar links das
pendentes**. O serviço seleciona somente a versão comercial atual de Offers
Shopee pendentes, processa no máximo 12 por execução e usa concorrência 1. Cada
item reutiliza o mesmo cliente Open API e, portanto, o mesmo rate limiter. O
fluxo usa a URL pública do Product, nunca o link candidato do Datafeed:

```text
DATAFEED -> import -> bulk generateShortLink -> AffiliateLink -> READY_TO_PUBLISH
```

O serviço individual usado por **Tentar Open API** também é usado pelo bulk. Ele
procura primeiro um link reutilizável, chama `generateShortLink` fora da
transação de escrita e relê a Offer sob lock antes de aplicar o resultado. Uma
execução repetida classifica links existentes como `ALREADY_LINKED` e não chama
a API. Isso preserva o `AffiliateLink`, evita versões duplicadas e trata uma
corrida concorrente antes da persistência.

Timeout, conexão interrompida, HTTP 429/5xx e erros oficiais temporários admitem
no máximo duas tentativas totais, com backoff curto. Erros de autenticação,
configuração, URL, Offer ou Sub ID não são repetidos. Uma falha específica não
cancela os sucessos anteriores; por exemplo, `10 linked / 2 pending`. Uma falha
global interrompe novas chamadas e classifica o restante como `NOT_ATTEMPTED`.
Os erros retornados ao dashboard e CLI contêm apenas códigos sanitizados.

Os Sub IDs internos do bulk são alfanuméricos: `sourcedatafeed` + `autolink`
após importação e `sourcedatafeed` + `bulk` na ação manual. O contrato estrito
`^[A-Za-z0-9]+$` permanece inalterado.

O auto-link pós-importação é progressivo e fica desligado por padrão:

```dotenv
SHOPEE_AUTO_LINK_AFTER_IMPORT="false"
SHOPEE_AUTO_LINK_MAX_PER_RUN="12"
SHOPEE_AUTO_LINK_CONCURRENCY="1"
```

Quando a primeira flag for explicitamente alterada para `true` e o modo
`HYBRID` estiver pronto, a importação faz commit primeiro e só então inicia o
bulk. Falha da Open API não desfaz Products ou Offers importados; eles continuam
`READY_FOR_AFFILIATE_LINK` com **Tentar Open API** e o fallback manual
`s.shopee.com.br` disponíveis. Em `DATAFEED`, nenhuma chamada Open API ocorre.

Operação local:

```powershell
npm run shopee:offers:status
npm run shopee:affiliate-links:generate -- --pending --dry-run
npm run shopee:affiliate-links:generate -- --pending --max 12 --confirm-generate
```

Sem `--confirm-generate`, o comando realiza zero requests e zero escritas. O
dry-run apenas informa quantas Offers seriam elegíveis. Resultado parcial usa
exit code 1 e falha global usa exit code 2. Nenhum desses fluxos cria
Publication, chama planner ou envia Telegram/WhatsApp.

## Smoke test controlado da Open API

O comando `shopee:open-api:smoke` serve exclusivamente para diagnosticar as
credenciais com uma única chamada `GenerateShortLink`. Ele reutiliza o cliente
produtivo, mas não importa Datafeed, não acessa PostgreSQL, Prisma ou Redis e não
cria nenhum registro. Sem `--confirm-live-call`, encerra com
`LIVE_CALL_NOT_CONFIRMED` antes de qualquer requisição.

Configure `SHOPEE_AFFILIATE_ENABLED=true`, modo `OPEN_API` ou `HYBRID`,
`SHOPEE_OPEN_API_APP_ID` e `SHOPEE_OPEN_API_SECRET` somente no ambiente do
processo. Use valores reais apenas em uma sessão local controlada:

```powershell
npm run shopee:open-api:smoke -- --origin-url "https://shopee.com.br/produto-ficticio-i.123.456" --item-id "456" --sub-id "diagnostico" --confirm-live-call
```

A URL e o item devem ser fornecidos pelo operador e corresponder exatamente. Até
cinco `--sub-id` podem ser repetidos. O resultado contém somente estado, número
de tentativas e, no sucesso, o shortlink oficial necessário à conferência. App
ID, Secret, assinatura, Authorization, payload e resposta bruta nunca são
impressos. Não cole credenciais na linha de comando, documentação, logs,
commits ou mensagens. Após o diagnóstico, remova as variáveis sensíveis da
sessão do terminal.
