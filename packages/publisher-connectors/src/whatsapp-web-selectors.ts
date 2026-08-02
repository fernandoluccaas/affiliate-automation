export const WHATSAPP_WEB_URL = "https://web.whatsapp.com/";

export const whatsappWebAccessibleAliases = {
  search: [
    "Search",
    "Search input textbox",
    "Search or start new chat",
    "Search or start a new chat",
    "Pesquisar",
    "Pesquisa",
    "Pesquisar ou iniciar nova conversa",
    "Buscar",
    "Buscar o iniciar un chat nuevo",
  ],
  newChat: ["New chat", "Nova conversa", "Nuevo chat"],
  message: ["Message", "Mensagem", "Mensaje"],
  attach: ["Attach", "Anexar", "Adjuntar"],
  photo: [
    "Photos & videos",
    "Photos and videos",
    "Fotos e vídeos",
    "Fotos y videos",
  ],
  caption: ["Add a caption", "Adicionar legenda", "Añade un comentario"],
  composer: ["Type a message", "Digite uma mensagem", "Escribe un mensaje"],
  send: ["Send", "Enviar"],
  close: ["Close", "Fechar", "Cerrar"],
  cancel: ["Cancel", "Cancelar"],
  back: ["Back", "Voltar", "Atrás"],
  readOnly: [
    "Only admins can send messages",
    "Somente admins podem enviar mensagens",
    "Solo los administradores pueden enviar mensajes",
  ],
  emptySearch: [
    "No chats, contacts or messages found",
    "Nenhuma conversa, contato ou mensagem encontrada",
    "No se encontraron chats, contactos ni mensajes",
  ],
} as const;

/**
 * Stable semantic fallbacks only. Dynamic class names are deliberately absent.
 * Every search selector is scoped to the left sidebar so message-search and the
 * conversation composer cannot be mistaken for global chat search.
 */
export const whatsappWebStableSelectors = {
  appShell: "#app",
  authenticatedShell: [
    "#side",
    "#pane-side",
    "[data-testid='chat-list']",
    "[aria-label='Chat list']",
    "[aria-label='Lista de conversas']",
    "[aria-label='Lista de chats']",
  ],
  sidebar: ["#side", "#pane-side", "[data-testid='chat-list']"],
  loadingOverlays: ["[aria-busy='true']", "[role='progressbar']"],
  qrCanvas: "canvas",
  searchTrigger: [
    "#side button[aria-label*='search' i]",
    "#side [role='button'][aria-label*='search' i]",
    "#side [role='button'][title*='search' i]",
    "#side button[aria-label*='pesquis' i]",
    "#side [role='button'][aria-label*='buscar' i]",
    "#side [data-testid='chat-list-search']",
  ],
  searchInput: [
    "#side [role='textbox'][aria-label*='search' i]",
    "#side [role='textbox'][aria-label*='pesquis' i]",
    "#side [role='textbox'][aria-label*='buscar' i]",
    "#side [contenteditable='true'][data-tab='3']",
    "#side [contenteditable='true'][role='textbox']",
    "[data-testid='chat-list-search'] [contenteditable='true']",
  ],
  searchResults: [
    "#pane-side",
    "#side [role='grid']",
    "#side [role='list']",
    "#side [aria-label*='result' i]",
    "#side [aria-label*='resultado' i]",
  ],
  genericSearchCandidate: [
    "#pane-side [role='listitem']",
    "#pane-side [role='row']",
    "#pane-side [data-testid='cell-frame-container']",
    "#pane-side [title]",
  ],
  conversationHeader: "#main header, main header",
  conversationTitle: [
    "#main header [title]",
    "main header [title]",
    "#main header [role='button'] [dir='auto']",
  ],
  composeBox: [
    "#main footer [contenteditable='true'][role='textbox']",
    "main footer [contenteditable='true'][role='textbox']",
    "footer [contenteditable='true'][data-tab='10']",
  ],
  readOnlyFooter: ["#main footer", "main footer"],
  attachButton: "footer [data-testid='clip']",
  sendButton: "[data-testid='send']",
  outgoingMessage: "[data-testid='msg-container'] [data-testid='msg-out']",
  mediaPreview: "[data-testid='media-canvas']",
} as const;

export function whatsappWebExactGroupResultSelectors(name: string) {
  const exactTitle = `[title=${JSON.stringify(name)}]`;
  return [
    `#pane-side [role='listitem']:has(${exactTitle})`,
    `#pane-side [role='row']:has(${exactTitle})`,
    `#pane-side [data-testid='cell-frame-container']:has(${exactTitle})`,
    `#pane-side ${exactTitle}`,
    `#side [role='listitem']:has(${exactTitle})`,
    `#side [role='row']:has(${exactTitle})`,
    `#side ${exactTitle}`,
  ] as const;
}
