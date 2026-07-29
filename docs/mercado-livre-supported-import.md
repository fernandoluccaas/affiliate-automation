# Mercado Livre: descoberta oficial e links manuais

O fluxo suportado usa OAuth para categorias, ranking e dados de produtos. A
fonte principal de mais vendidos é `GET /highlights/MLB/category/{categoryId}`.
Cada oferta preserva a categoria de origem, a posição, o tipo do highlight e a
estratégia usada para resolver o item final.

A geração do link comissionado continua no Portal oficial do Mercado Livre. O
discovery usa `ManualAffiliateLinkProvider`, que retorna
`MANUAL_REQUIRED` e nunca inventa um link nem usa a URL original como fallback.
Por isso uma oferta válida sem link termina em `READY_FOR_AFFILIATE_LINK`.

Links importados são aceitos somente quando são URLs HTTPS absolutas, sem
credenciais embutidas e com host permitido. A comparação de domínio exige o
host exato ou um subdomínio real; domínios parecidos são rejeitados.

Alterações apenas de ranking não participam do fingerprint comercial. Assim,
uma mudança da posição 8 para 9 atualiza os metadados da versão atual quando
ela ainda é mutável, sem criar uma nova versão por si só.

## Importação manual

A tela `/ofertas/affiliate-links` oferece:

1. edição rápida de várias linhas da tabela;
2. colagem no formato `externalId|affiliateUrl` ou
   `productUrl|affiliateUrl`;
3. CSV com `externalId,productUrl,affiliateUrl` (vírgula ou ponto e vírgula,
   com ou sem BOM).

O preview separa válidos, não encontrados, duplicados, links inválidos e links
já aplicados. A confirmação cria um `ImportJob` de fonte
`AFFILIATE_LINK_BATCH` e um `ImportJobItem` por linha. Falhas são isoladas.

Quando o produto já existe, o caso de uso reutiliza seus fatos e chama
`ingestOffer`, criando uma nova versão apenas quando o fingerprint comercial
muda. Quando o lote contém uma URL de produto ainda desconhecida, o ID MLB é
extraído da URL, o item é resolvido pela API oficial com OAuth e só então é
ingerido. A restrição única `marketplace + externalProductId` impede produtos
duplicados.
