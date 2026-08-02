import type { Locator, Page } from "playwright";
import {
  WHATSAPP_WEB_URL,
  whatsappWebAccessibleAliases,
  whatsappWebStableSelectors,
} from "./whatsapp-web-selectors";
import type {
  AuthenticationState,
  OutgoingMessageConfirmation,
  PreparedDraftInspection,
  WhatsAppGroupLocationResult,
  WhatsAppWebPageAdapter,
} from "./whatsapp-web-types";

function normalizedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export class PlaywrightWhatsAppWebPageAdapter implements WhatsAppWebPageAdapter {
  constructor(
    private readonly page: Page,
    private readonly confirmationTimeoutMs: number,
    private readonly actionTimeoutMs = 30_000,
  ) {}

  async navigate() {
    await this.page.goto(WHATSAPP_WEB_URL, { waitUntil: "domcontentloaded" });
  }

  async detectAuthenticationState(): Promise<AuthenticationState> {
    const deadline = Date.now() + this.actionTimeoutMs;
    do {
      const composerOrSearch = await this.firstVisible([
        this.page.locator(whatsappWebStableSelectors.chatList),
        ...whatsappWebAccessibleAliases.search.map((name) =>
          this.page.getByRole("textbox", { name }),
        ),
      ]);
      if (composerOrSearch) return "CONNECTED";

      const qrVisible = await this.page
        .locator(whatsappWebStableSelectors.qrCanvas)
        .first()
        .isVisible()
        .catch(() => false);
      const loginVisible = await this.firstVisible([
        this.page.getByText("Log in with phone number", { exact: false }),
        this.page.getByText("Entrar com numero de telefone", { exact: false }),
        this.page.getByText("Link with phone number", { exact: false }),
      ]);
      if (qrVisible || loginVisible) return "LOGIN_REQUIRED";
      await this.page.waitForTimeout(250);
    } while (Date.now() < deadline);
    return "UNEXPECTED_STATE";
  }

  async locateGroupExact(name: string): Promise<WhatsAppGroupLocationResult> {
    const search = await this.searchBox();
    if (!search) {
      return this.locationFailure(
        "SELECTOR_MISMATCH",
        "WHATSAPP_WEB_SELECTOR_MISMATCH",
      );
    }
    await search.fill(name);
    await this.page.waitForTimeout(500);
    const titled = this.page.locator(`[title=${JSON.stringify(name)}]`);
    const count = await titled.count();
    const exact: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = titled.nth(index);
      const title = await candidate.getAttribute("title");
      if (title && normalizedText(title) === normalizedText(name))
        exact.push(candidate);
    }
    if (exact.length === 0) {
      return this.locationFailure(
        "GROUP_NOT_FOUND",
        "WHATSAPP_WEB_GROUP_NOT_FOUND",
      );
    }
    if (exact.length > 1) {
      return this.locationFailure(
        "GROUP_AMBIGUOUS",
        "WHATSAPP_WEB_GROUP_AMBIGUOUS",
      );
    }
    return {
      status: "GROUP_FOUND",
      exactMatch: true,
      publishPermission: false,
    };
  }

  async openGroup(name: string) {
    const candidate = this.page
      .locator(`[title=${JSON.stringify(name)}]`)
      .first();
    if (!(await candidate.isVisible().catch(() => false))) {
      throw new Error("WHATSAPP_WEB_GROUP_NOT_FOUND");
    }
    await candidate.click();
  }

  async verifyOpenedGroup(name: string) {
    const titles = this.page.locator(
      whatsappWebStableSelectors.conversationTitle,
    );
    const count = await titles.count();
    for (let index = 0; index < count; index += 1) {
      const title = await titles.nth(index).getAttribute("title");
      if (title && normalizedText(title) === normalizedText(name)) return true;
    }
    return false;
  }

  async verifyPublishPermission() {
    return Boolean(await this.composer());
  }

  async attachImage(path: string) {
    const attach = await this.firstVisible([
      this.page.locator(whatsappWebStableSelectors.attachButton),
      ...whatsappWebAccessibleAliases.attach.map((name) =>
        this.page.getByRole("button", { name, exact: true }),
      ),
    ]);
    if (!attach) throw new Error("WHATSAPP_WEB_SELECTOR_MISMATCH");
    await attach.click();
    const input = this.page
      .locator("input[type='file'][accept*='image']")
      .last();
    if ((await input.count()) === 0)
      throw new Error("WHATSAPP_WEB_MEDIA_UPLOAD_FAILED");
    await input.setInputFiles(path);
  }

  async fillCaption(text: string) {
    const caption = await this.firstVisible([
      ...whatsappWebAccessibleAliases.caption.map((name) =>
        this.page.getByRole("textbox", { name }),
      ),
      this.page.locator(
        "[data-testid='media-caption-input-container'] [contenteditable='true']",
      ),
    ]);
    if (!caption) throw new Error("WHATSAPP_WEB_SELECTOR_MISMATCH");
    await caption.fill(text);
  }

  async fillText(text: string) {
    const composer = await this.composer();
    if (!composer) throw new Error("WHATSAPP_WEB_NO_PUBLISH_PERMISSION");
    await composer.fill(text);
  }

  async inspectPreparedDraft(input: {
    affiliateUrl: string;
    textSnippet: string;
    mediaExpected: boolean;
  }): Promise<PreparedDraftInspection> {
    const draftText = await this.page
      .locator("footer, [data-testid='media-caption-input-container']")
      .allInnerTexts();
    const text = normalizedText(draftText.join(" "));
    const mediaFound = await this.page
      .locator(whatsappWebStableSelectors.mediaPreview)
      .isVisible()
      .catch(() => false);
    return {
      affiliateUrlFound: text.includes(input.affiliateUrl),
      textSnippetFound: text.includes(normalizedText(input.textSnippet)),
      mediaFound: input.mediaExpected ? mediaFound : true,
    };
  }

  async send() {
    const button = await this.firstVisible([
      this.page.locator(whatsappWebStableSelectors.sendButton),
      ...whatsappWebAccessibleAliases.send.map((name) =>
        this.page.getByRole("button", { name, exact: true }),
      ),
    ]);
    if (!button) throw new Error("WHATSAPP_WEB_SELECTOR_MISMATCH");
    await button.click();
  }

  async confirmOutgoingMessage(input: {
    affiliateUrl: string;
    textSnippet: string;
    mediaExpected: boolean;
    sentAfter: Date;
  }): Promise<OutgoingMessageConfirmation> {
    const outgoing = this.page
      .locator(whatsappWebStableSelectors.outgoingMessage)
      .last();
    try {
      await outgoing.waitFor({
        state: "visible",
        timeout: this.confirmationTimeoutMs,
      });
      const text = normalizedText(await outgoing.innerText());
      const affiliateUrlFound = text.includes(input.affiliateUrl);
      const textSnippetFound = text.includes(normalizedText(input.textSnippet));
      const mediaFound = input.mediaExpected
        ? (await outgoing.locator("img, [data-testid*='media']").count()) > 0
        : true;
      return {
        confirmed: affiliateUrlFound && textSnippetFound && mediaFound,
        affiliateUrlFound,
        textSnippetFound,
        mediaFound,
      };
    } catch {
      return {
        confirmed: false,
        affiliateUrlFound: false,
        textSnippetFound: false,
        mediaFound: false,
      };
    }
  }

  async clearDraft() {
    const captionOrComposer = await this.firstVisible([
      ...whatsappWebAccessibleAliases.caption.map((name) =>
        this.page.getByRole("textbox", { name }),
      ),
      this.page.locator(whatsappWebStableSelectors.composeBox),
    ]);
    if (captionOrComposer) await captionOrComposer.fill("");
    const cancel = await this.firstVisible(
      whatsappWebAccessibleAliases.cancel.map((name) =>
        this.page.getByRole("button", { name, exact: true }),
      ),
    );
    if (cancel) await cancel.click();
  }

  async isDraftClear() {
    const composer = await this.composer();
    if (!composer) return true;
    return normalizedText(await composer.innerText().catch(() => "")) === "";
  }

  async capturePreparedDraft(path: string) {
    const draft = this.page
      .locator("[data-testid='media-caption-input-container'], footer")
      .last();
    if (!(await draft.isVisible().catch(() => false))) {
      throw new Error("WHATSAPP_WEB_SELECTOR_MISMATCH");
    }
    await draft.screenshot({ path });
  }

  private async searchBox() {
    return this.firstVisible([
      this.page.locator(whatsappWebStableSelectors.searchBox),
      ...whatsappWebAccessibleAliases.search.map((name) =>
        this.page.getByRole("textbox", { name }),
      ),
    ]);
  }

  private async composer() {
    return this.firstVisible([
      this.page.locator(whatsappWebStableSelectors.composeBox),
      ...whatsappWebAccessibleAliases.composer.map((name) =>
        this.page.getByRole("textbox", { name }),
      ),
    ]);
  }

  private async firstVisible(locators: Locator[]) {
    for (const locator of locators) {
      const candidate = locator.first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
  }

  private locationFailure(
    status: WhatsAppGroupLocationResult["status"],
    errorCode: NonNullable<WhatsAppGroupLocationResult["errorCode"]>,
  ): WhatsAppGroupLocationResult {
    return { status, exactMatch: false, publishPermission: false, errorCode };
  }
}
