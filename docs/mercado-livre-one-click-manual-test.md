# Teste manual: mais vendidos com link afiliado

## Preparação

1. Configure OAuth, PostgreSQL e Redis conforme o README.
2. Mantenha `MERCADO_LIVRE_AFFILIATE_ENDPOINT_MODE="stripe_v2"`.
3. Em `/integracoes/mercado-livre`, conecte o OAuth.
4. Cole manualmente o cookie da sua própria sessão do Portal de Afiliados,
   salve, valide as tags e selecione uma tag.
5. Use o gerador de teste com uma URL pública. Confirme que a tela mostra
   somente modo, horário e um link real `https://meli.la/...`.

## Categoria e importação

1. Navegue pela hierarquia `MLB1051` até `MLB1055` e continue até selecionar
   uma categoria folha compatível.
2. Marque a categoria, configure um limite entre 1 e 20 e salve.
3. Clique em **Importar mais vendidos e gerar links**.
4. Durante a execução, confirme o estado
   **Importando, resolvendo e gerando links...**.
5. No relatório do último ImportJob, confira encontrados, resolvidos, links
   gerados, criados, atualizados, pendentes, inelegíveis e falhas individuais.

## Resultado esperado

- A origem do ranking é `/highlights/MLB/category/{categoryId}`.
- `ITEM`, `PRODUCT` e `USER_PRODUCT` resolvem para um item final; PRODUCT pode
  usar `/products/{PRODUCT_ID}/items`.
- A oferta preserva posição, categoria, tipo de highlight e estratégia.
- Com sessão válida, a oferta recebe um `meli.la` real e só fica
  `READY_TO_PUBLISH` se também passar pelas regras determinísticas.
- Sem sessão ou após 401/403, os produtos restantes são persistidos em
  `READY_FOR_AFFILIATE_LINK`; o OAuth continua conectado.
- Uma falha individual aparece em `ImportJobItem` e não cancela os demais.
- A lista `/ofertas` mostra imagem, preços, desconto, ranking, origem, URL
  original, link afiliado, status e o botão **Copiar link** somente quando o
  link existe.

## Segurança

Inspecione logs, alertas e URLs da aplicação. Eles não podem conter cookie,
CSRF, OAuth token, `Authorization` ou valores criptografados. O teste não
automatiza login, MFA ou CAPTCHA.
