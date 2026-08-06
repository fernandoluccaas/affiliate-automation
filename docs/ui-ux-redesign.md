# Fase 6D — Redesign do dashboard

## Escopo e limites

Esta fase reorganiza a apresentação do dashboard sem alterar regras de negócio, actions, APIs, autenticação, Prisma, worker, scheduler, publicação ou integrações. O dashboard continua sendo um console administrativo autenticado. Nenhuma ação externa é executada durante o redesign.

## Auditoria inicial

### Problemas transversais encontrados

- O shell tinha um cabeçalho largo e uma navegação em card que era empilhada antes do conteúdo em telas menores.
- Não havia breadcrumbs, navegação agrupada, menu mobile, preferência de tema ou persistência do estado da sidebar.
- A tipografia usava Arial e não havia escala, números tabulares nem tokens semânticos suficientes.
- Cores de sucesso, aviso e erro eram definidas diretamente nas páginas, com comportamento inconsistente no tema escuro.
- Estados de domínio eram frequentemente exibidos como enums sem tradução e dependiam principalmente de cor.
- Filtros, tabelas, métricas, feedback e estados vazios repetiam markup e estilos.
- Tabelas largas não tinham um padrão único de região rolável e nome acessível.
- Ações e mensagens de query string ficavam visualmente desconectadas do conteúdo relacionado.
- Informações técnicas e tarefas comuns recebiam o mesmo peso visual.
- A página Mercado Livre concentrava configuração, sessão afiliada, descoberta, histórico, categorias e probes em mais de duas mil linhas.
- Ao abrir uma categoria folha diretamente, não havia ação para adicioná-la. O resultado do teste também não oferecia a próxima ação.
- Diversas mensagens visíveis estavam sem acentuação em português.

### Inventário de páginas

| Rota                         | Finalidade e público          | Tarefas e conteúdo                                            | Problemas observados                                    | Migração aplicada                                                                    |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `/`                          | Resumo para operador          | métricas, cliques e alertas                                   | pouca orientação e gráfico sem tooltip                  | métricas semânticas, alerta acionável, gráfico responsivo e estado vazio explicativo |
| `/login`                     | autenticação administrativa   | email, senha e erro                                           | pouca hierarquia, sem tema e feedback genérico          | layout central, foco inicial, tema, erro com `role=alert` e loading                  |
| `/produtos`                  | catálogo consolidado          | consulta de Product                                           | apenas placeholder                                      | busca, filtro por marketplace e tabela somente leitura                               |
| `/ofertas`                   | operação comercial            | filtros, preços, score, origem e links                        | tabela muito larga, enums e técnica dominante           | filtro responsivo, container rolável, status humano e paginação semântica            |
| `/ofertas/nova`              | cadastro manual               | produto, preço e promoção                                     | labels não associados e feedback disperso               | agrupamento, labels envolventes, erros anunciados e barra de ação sticky             |
| `/ofertas/affiliate-links`   | correção de links             | edição, pipe, CSV, preview e confirmação                      | loading e resultados pouco consistentes                 | feedback semântico, tabelas nomeadas, status e bloqueio de duplo clique              |
| `/cupons`                    | consulta de cupons            | código, validade e oferta                                     | apenas placeholder                                      | lista real somente leitura com validade e estado                                     |
| `/canais`                    | administração de destinos     | criar, editar, testar e controlar canal                       | formulário longo e estados textuais                     | hierarquia, cards consistentes, status e microcopy; contratos dos campos preservados |
| `/publicacoes`               | auditoria de publicação       | snapshots, tentativas, fila e revisão                         | 15 colunas e detalhes técnicos dominantes               | status humano, rolagem contida e stepper WhatsApp dentro do detalhe técnico          |
| `/publicacoes-assistidas`    | fila WhatsApp assistida       | filtro, conteúdo, confirmação humana                          | pouca separação de status e ação                        | título orientado à tarefa, métricas e cards responsivos                              |
| `/automacoes`                | estado do worker              | pausas, métricas e runs                                       | enums crus e JSON em primeiro plano                     | alertas, StatusBadge e métricas técnicas recolhidas                                  |
| `/integracoes`               | visão das conexões            | IA e Mercado Livre                                            | cards sem padrão de estado                              | cards consistentes, descrição, última atividade e ações hierarquizadas               |
| `/integracoes/mercado-livre` | operação da integração        | OAuth, sessão, discovery, categorias, histórico e diagnóstico | página monolítica e ação de categoria ausente           | subnavegação, âncoras, opções avançadas recolhidas e adição em três contextos        |
| `/resultados`                | analytics somente leitura     | filtros, cliques, conversões e moedas                         | métricas duplicadas e estado técnico cru                | MetricCard, filtros compactos, status e moedas preservadas separadamente             |
| `/operacoes`                 | console local                 | saúde, supervisor, filas, backup e auditoria                  | muitos cards equivalentes e comandos sem ação de copiar | prioridade por status, comandos com alerta e cópia explícita                         |
| `/logs`                      | investigação de alertas       | severidade, origem, mensagem e reconhecimento                 | filtros limitados e enums                               | busca, status traduzido e tabela nomeada                                             |
| `/configuracoes`             | orientação sobre configuração | estado somente leitura                                        | texto sem próxima ação                                  | callout de segurança e orientação para Canais/Integrações                            |

As rotas de health, OAuth callback, redirect de tracking e imagem assistida não possuem interface de página e foram preservadas.

## Princípios

1. A tarefa principal aparece antes dos detalhes técnicos.
2. Uma ação primária domina cada seção; ações secundárias usam menor ênfase.
3. Estado é comunicado por ícone, texto e cor semântica.
4. IDs são secundários, monoespaçados e truncáveis; informações completas continuam disponíveis.
5. Tabelas permanecem contidas no próprio componente e nunca ampliam o `body`.
6. Server Components continuam sendo o padrão. Client Components são usados apenas em tema, shell, overlays, clipboard, formulários e gráficos.
7. Nenhum dado é inventado: estados vazios explicam a ausência e a próxima ação possível.

## Sistema visual

`globals.css` define tokens para background, superfícies, sidebar, foreground, muted, bordas, primary, sucesso, aviso, perigo, informação, foco, overlay, cinco séries de gráfico, sombras, raios, espaçamento e larguras de conteúdo. O tema escuro usa os mesmos nomes semânticos.

A pilha tipográfica é `Segoe UI Variable`, `Segoe UI`, `Inter`, `ui-sans-serif`, `system-ui`, `sans-serif`; nenhuma fonte é baixada. Métricas, preços, IDs e timestamps usam números tabulares. O foco visível tem três pixels e contraste independente do tema.

Não foram adicionados gradientes, glassmorphism ou dependências visuais. Sombras são usadas apenas para hierarquia entre superfície e conteúdo.

## Tema

Há três preferências: sistema, claro e escuro. A preferência é persistida em `localStorage` sob `affiliate-theme`; nunca sai do navegador. Um script mínimo no `<head>` aplica a preferência explícita antes da hidratação, evitando flash do tema incorreto. A preferência de sistema continua seguindo `prefers-color-scheme`.

## Shell e navegação

- Desktop: sidebar fixa de 264 px, recolhível para 80 px e independente da rolagem.
- Tablet e mobile: a navegação não antecede o conteúdo; um botão abre um Sheet visual com `role=dialog`.
- O menu mobile prende foco, fecha com Escape, bloqueia a rolagem de fundo e devolve foco ao gatilho.
- A preferência de sidebar é persistida em `affiliate-sidebar-collapsed`.
- A navegação é agrupada em Visão geral, Catálogo, Distribuição, Integrações e Sistema.
- O item ativo usa `aria-current=page`, texto, contraste e indicador lateral.
- Há skip link, landmarks e breadcrumb em todas as páginas do shell.
- O topbar contém contexto, tema e menu de usuário; logout permanece uma server action.

## Componentes compartilhados

- `Button`: variantes primary/default, secondary, outline, ghost, danger e link; tamanhos, loading e bloqueio de clique duplo. O componente é uma fronteira cliente explícita para compatibilidade com React Server Components e Radix Slot. As variantes CSS ficam no módulo puro `button-variants.ts`, que pode ser usado por Server Components sem criar handlers. Em `asChild`, o único filho continua sendo o elemento interativo; loading e disabled usam `aria-busy`/`aria-disabled` e bloqueio no cliente sem envolver links em botões.
- `Card`: cabeçalho, título, descrição e conteúdo consistentes.
- `StatusBadge`: tradução e tom único para estados de integração, oferta, publicação, worker e alerta.
- `Alert`: sucesso, informação, aviso e perigo com ícone e regiões live quando necessário.
- `Input`, `Select`, `Textarea`, `Checkbox`, `Switch` e `FormField`: altura mínima, foco, disabled, ajuda e erro.
- `PageTabs`, `Section`, `MetricGrid`, `MetricCard` e `TechnicalDetails`: hierarquia de página.
- `DataTableContainer`, `FilterBar` e `Pagination`: tabelas nomeadas, scroll contido e navegação.
- `Dialog` e `Sheet`: Escape, foco preso, overlay e retorno de foco.
- `EmptyState`, `LoadingState`, `ErrorState`, `Progress` e `Skeleton`: estados explícitos.
- `CopyButton`: cópia local com feedback e accessible name.
- `WhatsAppPublicationStepper`: Planejada, Inspeção, Autorização, Preflight, Envio e Confirmação.

## Mercado Livre

A página recebeu subnavegação para Visão geral, Descoberta, Categorias, Links afiliados, Histórico e Diagnósticos. A configuração de cookie permanece protegida em “Configuração avançada da sessão”; o valor salvo nunca é renderizado. IDs manuais de categoria ficam em “Opções avançadas”.

Uma categoria folha agora pode ser adicionada:

1. na lista de subcategorias;
2. no detalhe da própria categoria folha;
3. depois de “Testar categoria”.

Categorias já configuradas exibem “Categoria adicionada” e direcionam para configuração/desativação. A action, seus campos, a validação leaf, OAuth, geração de `meli.la`, discovery multicategoria e query params foram preservados.

## Acessibilidade

- Objetivo prático WCAG 2.2 AA para contraste, foco e operação por teclado.
- Áreas de toque têm no mínimo 44 × 44 px nas ações principais.
- Ícones decorativos têm `aria-hidden`; botões de ícone têm nome acessível.
- Feedback de erro usa `role=alert`; feedback não crítico usa `role=status`.
- Tabelas possuem cabeçalhos e uma região de scroll nomeada.
- Overlays suportam Escape, trap e retorno de foco.
- `prefers-reduced-motion` reduz transições e animações.
- O layout permanece legível em zoom de 200%, com colunas fluidas e conteúdo técnico rolável localmente.

## Responsividade

As classes foram desenhadas para 360, 390, 768, 1024, 1280, 1440 e 1920 px. Em mobile, conteúdo e ações viram uma coluna; filtros passam de uma coluna para grades somente quando há espaço. Tabelas usam scroll dentro do container. A sidebar só aparece fixa a partir de `lg` (1024 px). Gráficos usam `ResponsiveContainer`.

## Feedback, loading e erros

Mensagens de query string continuam sendo interpretadas pelas mesmas páginas e agora são apresentadas como `Alert`. Botões assíncronos client-side anunciam o estado em andamento e ficam desabilitados. Erros técnicos brutos permanecem em detalhes ou logs; o fluxo principal usa microcopy contextual em português brasileiro.

## Testes

Foram adicionados testes semânticos para navegação agrupada, rota ativa, breadcrumb, skip link, menu mobile, Escape, retorno de foco, sidebar persistida, tema, Button loading, StatusBadge, Alert, Tabs, Dialog, FormField, Table e EmptyState. O teste da integração Mercado Livre cobre as três posições da ação de adicionar, o estado já adicionado e a separação dos diagnósticos.

Os testes consultam role, name, heading, status e alert. Não há snapshots de página, Playwright, Chromium ou chamadas externas.

## Limitações conscientes

- A página Mercado Livre ainda agrega muitos dados porque cada query e action existente foi preservada. As responsabilidades visuais foram separadas por subnavegação e componentes compartilhados; uma divisão adicional das queries exigiria uma refatoração de backend fora desta fase.
- Tabelas operacionais com muitos campos continuam disponíveis para diagnóstico, mas agora têm scroll contido e detalhes recolhíveis. Não foram removidos campos.
- O dashboard não executa dispatch WhatsApp, worker, supervisor, imports ou publicação. Os comandos mostrados são texto copiável e continuam sendo executados apenas no terminal local.

## Interações locais do Mercado Livre

A rota `/integracoes/mercado-livre` permanece um Server Component e entrega os
dados iniciais como DTOs serializáveis. Quatro ilhas cliente pequenas cuidam das
interações que precisam preservar o contexto visual:

- o seletor hierárquico abre subcategorias, volta pelo histórico local, testa e
  adiciona categorias folha sem mudar a URL;
- o formulário de discovery salva a configuração sem recarregar a página e
  mantém valores ainda não enviados;
- a sessão afiliada salva, valida, atualiza tag, testa links e processa links
  pendentes com feedback no próprio painel;
- os diagnósticos de PRODUCT e o probe de categoria exibem resultados
  sanitizados inline, sem transportar payloads pela query string;
- a importação manual continua usando o serviço de discovery existente, mas o
  resumo retorna ao botão sem redirect e sem recarregar a rota;
- respostas fora de ordem são descartadas por uma sequência de requisição;
- loading é localizado na ação em andamento, erros ficam junto ao componente e
  sucessos são anunciados com regiões `aria-live`;
- uma categoria adicionada atualiza também a tabela de configuração, sem
  remontar a página;
- as actions retornam unions tipadas de sucesso/erro e nunca serializam cookie,
  CSRF, tokens ou outros segredos.

O HTML mantém formulários progressivos dentro de `noscript` para ambientes sem
JavaScript. OAuth, importações e diagnósticos avançados continuam separados;
nenhuma regra de geração de `meli.la`, descoberta ou publicação foi movida para
o cliente.
