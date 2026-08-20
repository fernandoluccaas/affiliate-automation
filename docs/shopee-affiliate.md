# Shopee Affiliate — Datafeed discovery

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
