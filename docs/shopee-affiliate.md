# Shopee Affiliate — Datafeed discovery

## Escopo da Fase 6A.2

A conta está aprovada no Programa de Afiliados Shopee e disponibiliza Datafeeds
oficiais diários. A Affiliate Open API também existe, mas a conta ainda não
possui AppID/Secret liberados. Por isso esta fase implementa somente leitura de
arquivos locais, descoberta determinística e preview.

Não há scraping, login automatizado, browser, download de feed, chamada à Open
API, escrita no banco, criação de `Product`, `Offer`, `AffiliateLink` ou
`Publication`, nem envio de mensagens.

## Modos

- `OFF`: padrão seguro; nenhum Datafeed é processado.
- `DATAFEED`: permite `inspect` e `preview` de caminhos locais explícitos.
- `OPEN_API`: `WAITING_FOR_OFFICIAL_ACCESS`, sem cliente HTTP ou assinatura.
- `HYBRID`: `WAITING_FOR_OFFICIAL_ACCESS` até a Open API ser liberada.

Configuração de exemplo:

```dotenv
SHOPEE_AFFILIATE_ENABLED="false"
SHOPEE_AFFILIATE_MODE="OFF"
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

## Links e gate de atribuição

`product_link` vira `sourceProductUrl`. `product_short link` vira
`candidateAffiliateUrl`. Ele só pode virar `verifiedAffiliateUrl` quando
`SHOPEE_DATAFEED_LINKS_VERIFIED=true` for habilitado explicitamente após a
confirmação de atribuição.

Com o padrão `false`, parsing, inspeção, ranking e preview continuam funcionando,
mas os links aparecem como `NÃO VERIFICADO`. O pacote bloqueia qualquer tentativa
operacional com `SHOPEE_DATAFEED_LINKS_NOT_VERIFIED`. Mesmo com o gate aberto, a
Fase 6A.2 permanece preview-only e responde `SHOPEE_DATAFEED_PREVIEW_ONLY` para
publicação.

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
```

`inspect` mostra schema, nome, tamanho, checksum, linhas, categorias, URLs,
shortlinks candidatos, duração e pico aproximado de heap. `preview` mostra
somente vencedores e métricas sanitizadas. Descrições e dumps de URLs não são
impressos em lote.

O dashboard em `/integracoes/shopee` oferece as mesmas operações com feedback
inline, pending localizado, prevenção de duplo clique e preservação de tab,
scroll e formulário. O arquivo continua no servidor; não há upload de 198 MB
para a memória do browser.

## Futuro Open API e atribuição

As interfaces `ShopeeOfferProvider`, `ShopeeAffiliateLinkProvider` e
`ShopeeConversionProvider` separam descoberta, links e conversões. A
implementação atual é `DatafeedOfferProvider`; providers Open API não possuem
base URL, headers, assinatura ou cliente HTTP e falham fechados até a liberação
oficial das credenciais. Um modo híbrido poderá trocar providers sem acoplar o
tracking ao formato `meli.la` do Mercado Livre.
