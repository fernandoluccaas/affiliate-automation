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
