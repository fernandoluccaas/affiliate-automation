# Shopee Affiliate — Datafeed discovery

## Escopo das Fases 6A.2 e 6A.3

A conta está aprovada no Programa de Afiliados Shopee e disponibiliza Datafeeds
oficiais diários. A Fase 6A.2 implementa leitura local, descoberta determinística
e preview. A Fase 6A.3 adiciona a confirmação operacional e a geração automática
de shortlinks pelo contrato GraphQL oficial `generateShortLink`.

Não há scraping, login automatizado, browser ou download remoto do feed. Somente
uma confirmação explícita pode criar `Product`, versões de `Offer`,
`AffiliateLink`, `ImportJob` e `ImportJobItem`. O fluxo termina em
`READY_TO_PUBLISH`: nunca cria `Publication` nem envia mensagens.

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

Até cinco SubIds opcionais são aceitos. O sistema usa identificadores não
sensíveis como `source_datafeed`, fase e retry; valores vazios, PII implícita,
caracteres fora de `[a-z0-9_-]` ou mais de cinco entradas são recusados.

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

## Persistência, idempotência e fallback

As interfaces `ShopeeOfferProvider`, `ShopeeAffiliateLinkProvider` e
`ShopeeConversionProvider` mantêm descoberta, links e conversões separadas. O
checksum da sessão combina os arquivos e vencedores; reimportações idênticas não
duplicam estado. Cada item usa lock consultivo PostgreSQL. Antes de chamar a API,
o serviço procura um `AffiliateLink` ativo para a mesma origem e hash dos SubIds.

Sucesso gera a versão comercial com link, `AffiliateLink.destination` e, depois
de reexecutar validação e score mínimo, status `READY_TO_PUBLISH`. API desativada,
credenciais ausentes ou erro mantém `READY_FOR_AFFILIATE_LINK` e registra somente
código sanitizado no item do job. O dashboard permite retry explícito e fallback
manual. O shortlink manual é validado e seus redirects são seguidos manualmente,
limitados a hosts oficiais, até confirmar o mesmo `itemId`.

O redirect `/go/[slug]` continua consultando exclusivamente
`AffiliateLink.destination`; URL do produto, candidato do Datafeed e `shope.ee`
não são fallbacks de tracking.

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
