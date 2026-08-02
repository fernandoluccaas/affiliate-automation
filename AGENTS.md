# Affiliate Automation Agent Guide

## Scope

This repository implements Affiliate Automation, a monorepo for collecting, validating, scoring, publishing and measuring affiliate offers from officially allowed integrations.

## Guardrails

* Do not add marketplace login automation, credential collection, password storage, CAPTCHA bypasses, MFA bypasses, session theft, or authentication circumvention.
* Do not add unofficial WhatsApp Web automation unless a separate repository-level authorization is added for that integration.
* The Mercado Livre affiliate integration is explicitly authorized to use a browser session cookie manually supplied by the authenticated repository owner or application user, exclusively for generating that same user's affiliate links.
* This Mercado Livre exception authorizes server-side requests only to the following affiliate-portal resources, or their direct versioned replacements:

  * `GET https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/tags`
  * `POST https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/links`
  * the Mercado Livre affiliate Link Builder page when required only to initialize or refresh CSRF/session cookies.
* The manually supplied Mercado Livre cookie may be normalized, encrypted, persisted, replayed server-side, refreshed from `Set-Cookie` response headers, and used to obtain the CSRF token required by the explicitly authorized affiliate-link flow.
* The Mercado Livre affiliate exception must not be generalized to unrelated marketplace pages, account operations, purchases, messages, seller operations, profile changes, or arbitrary authenticated scraping.
* The system must not automate the Mercado Livre login process. Users must obtain and provide their own active cookie manually.
* Cookies, CSRF tokens, OAuth tokens, refresh tokens, authorization headers, and other secrets must never be written to logs, error messages, browser state, client-visible bundles, analytics, screenshots, fixtures, or committed files.
* Secrets persisted in the database must be encrypted at rest using the repository's credential-encryption utilities.
* The frontend may display only whether a cookie is configured, its status, and the last validation date. It must never receive the saved cookie value.
* A `401`, `403`, redirect to login, or authentication response must mark only the Mercado Livre affiliate session as expired. It must not disconnect the separate OAuth integration.
* The implementation must apply rate limits, bounded concurrency, request timeouts, limited retries, and per-product error isolation.
* Product discovery, categories, rankings, and other documented marketplace resources must continue to use the official OAuth/API integration whenever available.
* Do not let AI decide whether an offer is valid. Validation and scoring must remain deterministic.
* Use PostgreSQL `Decimal` fields for monetary values and percentages that affect business rules.
* Mocks are allowed only in tests and local development, and must be clearly identified.

## Authorized Mercado Livre Affiliate Session Scope

The repository owner explicitly authorizes implementation of the manual-cookie Mercado Livre affiliate flow described above.

This authorization covers:

1. accepting a cookie copied manually by the user;
2. encrypting and saving it server-side;
3. validating the session;
4. retrieving the user's affiliate tags;
5. retrieving and refreshing CSRF/session values needed by the authorized endpoints;
6. generating real `meli.la` links for product URLs;
7. updating the encrypted session after receiving new `Set-Cookie` headers;
8. marking the session as expired when authentication fails;
9. generating affiliate links during category imports and for pending offers.

This authorization does not cover:

1. collecting usernames, passwords, MFA codes, or recovery codes;
2. logging into Mercado Livre on behalf of the user;
3. bypassing CAPTCHA, MFA, rate limits, or access controls;
4. accessing another user's account or session;
5. performing purchases or account changes;
6. arbitrary authenticated scraping;
7. exposing, exporting, or sharing session secrets.

When this explicitly authorized integration conflicts with the general prohibition on authenticated scraping, this narrowly scoped Mercado Livre affiliate-session authorization takes precedence.


## Phase Workflow

Each phase must:

1. List files to be changed.
2. Implement only the phase scope.
3. Run lint, typecheck and tests.
4. Fix all errors found.
5. Update documentation.
6. Create a small descriptive commit.

Do not start Phase 2 until Phase 1 is complete.

## Local Commands

- `npm install`
- `docker compose up -d`
- `npm run prisma:migrate`
- `npm run db:seed`
- `npm run dev`
- `npm run lint`
- `npm run typecheck`
- `npm run test`

## Exceção autorizada — WhatsApp Groups Web Experimental

O proprietário do projeto autoriza uma implementação experimental, opcional e
desativada por padrão para publicar ofertas exclusivamente em grupos do WhatsApp
aos quais pertence ou que administra.

A implementação autorizada deve utilizar somente Playwright para controlar a
interface visual do WhatsApp Web.

### Escopo permitido

É permitido:

- abrir o WhatsApp Web com Chromium controlado por Playwright;
- utilizar perfil persistente exclusivo do projeto;
- realizar login manual por QR Code;
- verificar o estado autenticado da sessão;
- localizar um grupo pelo nome exato configurado;
- verificar se o compositor está disponível;
- preparar imagem e legenda;
- executar dry run sem envio;
- realizar no máximo uma publicação por execução quando explicitamente
  confirmado pelo proprietário;
- confirmar visualmente o envio;
- utilizar Redis lock para impedir concorrência;
- pausar automaticamente o grupo após o primeiro envio bem-sucedido;
- registrar estados operacionais sanitizados;
- classificar envios inconclusivos como DELIVERY_UNCERTAIN;
- realizar diagnóstico seguro de seletores, shell autenticado, pesquisa,
  resultados, header e compositor.

### Restrições obrigatórias

A implementação deve permanecer:

- desativada por padrão;
- com dry run ativado por padrão;
- limitada inicialmente a uma publicação por execução;
- limitada a grupos explicitamente configurados;
- restrita aos grupos pertencentes ou administrados pelo proprietário;
- independente do Telegram e do modo assistido;
- interrompível imediatamente por feature flag;
- protegida por Redis lock antes de abrir o navegador.

É proibido:

- usar bibliotecas que implementem protocolo não oficial do WhatsApp;
- usar whatsapp-web.js, Baileys ou ferramentas semelhantes;
- enviar mensagens para números individuais;
- automatizar grupos não configurados;
- enumerar ou armazenar grupos e conversas;
- coletar membros, telefones ou histórico de mensagens;
- ler conteúdo de mensagens que não seja necessário para confirmar a própria
  publicação recém-enviada;
- automatizar senha, SMS, PIN, MFA ou CAPTCHA;
- capturar, exportar ou exibir QR Code;
- exportar cookies, localStorage, storageState ou arquivos de sessão;
- enviar arquivos do perfil do navegador ao dashboard, banco ou logs;
- utilizar o perfil principal do navegador pessoal;
- usar cliques por coordenadas;
- selecionar resultados por correspondência parcial ou aproximada;
- clicar no primeiro resultado sem correspondência exata;
- executar disparos em massa;
- fazer retry automático após o clique em enviar quando a entrega for
  inconclusiva;
- registrar nomes de outras conversas, mensagens, telefones ou dados privados
  em diagnósticos;
- capturar screenshots de QR Code ou da lista ampla de conversas por padrão;
- contornar autenticação, limitações ou proteções da plataforma.

### Dry run

O dry run deve ser estruturalmente separado do envio real.

Durante o dry run:

- o grupo exato pode ser localizado;
- imagem e texto podem ser preparados;
- o rascunho pode ser validado;
- o botão de envio nunca pode ser acionado;
- o rascunho deve ser limpo ao final;
- a Publication não pode ser marcada como PUBLISHED.

### Envio real

O envio real exige simultaneamente:

- feature experimental explicitamente habilitada;
- dry run desativado explicitamente;
- confirmação de propriedade/autorização do grupo;
- grupo configurado em modo WEB_EXPERIMENTAL;
- perfil autenticado;
- Redis disponível;
- correspondência exata do grupo;
- dry run válido para a configuração atual;
- comando explícito com confirmação de envio;
- limite máximo de uma publicação por execução.

Se o clique em enviar tiver ocorrido, mas a confirmação não for conclusiva:

- usar DELIVERY_UNCERTAIN;
- bloquear retry automático;
- exigir revisão manual antes de qualquer nova tentativa.

Mudanças na interface do WhatsApp Web podem interromper essa automação. O modo
assistido deve permanecer disponível como fallback.
