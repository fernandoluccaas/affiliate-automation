export const WHATSAPP_WEB_URL = "https://web.whatsapp.com/";

export const whatsappWebAccessibleAliases = {
  search: [
    "Search input textbox",
    "Search or start new chat",
    "Pesquisar ou iniciar nova conversa",
  ],
  attach: ["Attach", "Anexar"],
  photo: ["Photos & videos", "Fotos e vídeos", "Photos and videos"],
  caption: ["Add a caption", "Adicionar legenda"],
  composer: ["Type a message", "Digite uma mensagem"],
  send: ["Send", "Enviar"],
  cancel: ["Cancel", "Cancelar"],
  back: ["Back", "Voltar"],
} as const;

export const whatsappWebStableSelectors = {
  appShell: "#app",
  qrCanvas: "canvas",
  chatList: "[data-testid='chat-list']",
  searchBox: "[data-testid='chat-list-search'] [contenteditable='true']",
  conversationHeader: "header",
  conversationTitle: "header [title]",
  composeBox: "footer [contenteditable='true'][role='textbox']",
  attachButton: "footer [data-testid='clip']",
  sendButton: "[data-testid='send']",
  outgoingMessage: "[data-testid='msg-container'] [data-testid='msg-out']",
  mediaPreview: "[data-testid='media-canvas']",
} as const;
