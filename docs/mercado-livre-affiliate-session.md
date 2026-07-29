# Sessão de afiliado do Mercado Livre

O OAuth e a sessão do Portal de Afiliados têm responsabilidades independentes:

- o OAuth consulta categorias, rankings e dados oficiais dos produtos;
- o cookie informado manualmente pelo próprio usuário consulta suas tags e
  gera links comissionados pelos endpoints autorizados do Link Builder.

O sistema não automatiza login, senha, MFA ou CAPTCHA. O cookie e o token CSRF
ficam somente no servidor, criptografados com AES-256-GCM, e nunca são
devolvidos ao navegador depois de salvos.

## Configuração do serviço

Defina uma chave exclusiva de pelo menos 16 caracteres (32 ou mais são
recomendados):

```env
CREDENTIALS_ENCRYPTION_KEY=""
MERCADOLIVRE_AFFILIATE_BASE_URL="https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user"
MERCADOLIVRE_AFFILIATE_REFERER="https://www.mercadolivre.com.br/afiliados/linkbuilder"
MERCADOLIVRE_AFFILIATE_USER_AGENT=""
MERCADOLIVRE_AFFILIATE_MAX_CONCURRENCY="4"
MERCADOLIVRE_AFFILIATE_TIMEOUT_MS="15000"
MERCADOLIVRE_AFFILIATE_MAX_RETRIES="3"
MERCADO_LIVRE_AFFILIATE_ENDPOINT_MODE="stripe_v2"
```

`ENCRYPTION_KEY` e `AUTH_SECRET` continuam aceitas para compatibilidade com
credenciais OAuth já persistidas. Quando `CREDENTIALS_ENCRYPTION_KEY` está
configurada, novas credenciais usam essa chave sem tornar os payloads antigos
ilegíveis.

## Teste real opt-in

O teste real não roda sem credenciais explícitas:

```env
MERCADOLIVRE_TEST_COOKIE=""
MERCADOLIVRE_TEST_AFFILIATE_LINK=""
MERCADOLIVRE_TEST_PRODUCT_URL=""
```

Execute:

```powershell
npm run test:integration:mercadolivre-affiliate
```

O teste valida a sessão, lista tags, gera um link e confirma o host HTTPS
permitido. Ele não imprime cookie, CSRF ou cabeçalhos de autenticação. Na
ausência de qualquer variável obrigatória, o caso é marcado como ignorado.

## Configuração no dashboard

Abra `/integracoes/mercado-livre`. A seção **Sessão de afiliado Mercado
Livre** é separada da conexão OAuth:

1. informe um link de afiliado de referência;
2. cole o cabeçalho `Cookie` completo obtido manualmente na sua própria sessão;
3. clique em **Salvar e testar**;
4. confira o status e a tag selecionada.

O campo do cookie sempre volta vazio depois do envio. A indicação **Cookie
configurado** confirma apenas a existência de um valor criptografado no
servidor. Deixar o campo vazio preserva o cookie existente; preencher e salvar
faz uma substituição explícita. **Limpar sessão** remove cookie, CSRF e tags sem
desconectar o OAuth.

Depois da primeira validação, todas as tags retornadas pela conta ficam
disponíveis para seleção. A interface recebe somente a lista normalizada, o
status, datas de validação/atualização e o último erro sanitizado.

Os estados possíveis são:

- `NOT_CONFIGURED`: nenhum cookie foi salvo;
- `VALIDATING`: uma validação está em andamento;
- `CONNECTED`: cookie válido e tag selecionada;
- `EXPIRED`: login/401/403 no Portal de Afiliados;
- `ERROR`: falha não relacionada à autenticação, com mensagem sanitizada.

## Importação automática e ofertas pendentes

O discovery continua usando OAuth e `GET /highlights/MLB/category/{categoryId}`
para ranking, categorias e produtos. Depois de resolver `ITEM`, `PRODUCT` ou
`USER_PRODUCT` para o item final, ele usa a sessão afiliada somente para gerar
o link e chama `ingestOffer` com a URL original e a URL `meli.la` em campos
distintos.

A geração usa concorrência limitada a quatro produtos. Cada falha fica isolada:

- o erro de produto não elegível marca a oferta como `INELIGIBLE` e impede
  publicação;
- erro transitório mantém a oferta em `READY_FOR_AFFILIATE_LINK`;
- `401`, `403` ou redirecionamento de login marcam apenas a sessão afiliada
  como `EXPIRED`, interrompem novas tentativas no lote e preservam o OAuth;
- produtos já resolvidos continuam sendo ingeridos mesmo sem link.

Importação e enriquecimento de pendências usam o mesmo lock distribuído,
renovado enquanto o lote estiver ativo. A persistência da rotação de cookie e
CSRF é otimista: se a sessão tiver sido substituída pelo usuário durante o lote,
o resultado antigo não sobrescreve a nova sessão.

Cada execução cria um `ImportJob` com contadores reais e `ImportJobItem` para os
diagnósticos por produto. `Offer` guarda categoria, posição, tipo original do
highlight e estratégia de resolução. Esses metadados operacionais não entram
no fingerprint; mudar apenas da posição 8 para 9 atualiza a origem sem criar uma
nova versão.

O botão **Gerar links pendentes** processa uma quantidade limitada de ofertas
`READY_FOR_AFFILIATE_LINK` e mantém o versionamento normal da ingestão. A página
`/ofertas/affiliate-links` deve ser usada somente como fallback manual.

O botão **Importar mais vendidos e gerar links** usa a mesma factory no
dashboard e no worker. Com uma sessão `CONNECTED`, o
`MercadoLivreAffiliateSessionLinkProvider` gera links reais pelo adapter do
Portal; sem sessão ou com cookie expirado, os produtos ainda são persistidos em
`READY_FOR_AFFILIATE_LINK`. O modo habilitado é `stripe_v2`. O modo conceitual
`create_link_v2` permanece bloqueado até existir autorização explícita para um
recurso compatível.

A seção da sessão também permite gerar um único link de teste a partir de uma
URL pública e da tag selecionada. A resposta visível contém apenas o modo, o
horário e o `meli.la`; cookie e CSRF permanecem criptografados no servidor.

## Worker, refresh e diagnósticos

O worker executa expiração, discovery, enriquecimento pendente, refresh,
agendamento, retry e publicação como etapas independentes. Uma falha no
discovery deixa o ciclo como `PARTIAL`, cria um alerta sanitizado e não impede
as etapas seguintes.

O refresh preserva o link afiliado e os metadados de ranking da versão atual e
registra `selected`, `refreshed`, `unchanged`, `newVersions`, `notFound`,
`failed` e `affiliateUrlsPreserved`. Publicações novas recebem snapshots da
categoria de origem, posição, highlight e estratégia de resolução.

Os eventos estruturados da integração aceitam somente IDs, etapa, duração,
status, tentativa, contagem e código de erro. Mensagens livres, URLs, cookie,
CSRF, `Authorization` e tokens não fazem parte desse contrato.
