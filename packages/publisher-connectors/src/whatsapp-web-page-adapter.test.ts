import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { PlaywrightWhatsAppWebPageAdapter } from "./whatsapp-web-page-adapter";
import {
  whatsappWebExactGroupResultSelectors,
  whatsappWebStableSelectors,
} from "./whatsapp-web-selectors";
import { WhatsAppWebStageError } from "./whatsapp-web-types";

type FakeNode = {
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  text?: string;
  title?: string;
  onClick?: () => void;
  onFill?: (value: string) => void;
  onSetInputFiles?: (path: string) => void;
};

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly key: string,
    private readonly index?: number,
  ) {}

  private nodes() {
    return this.page.nodes.get(this.key) ?? [];
  }

  private node() {
    return this.nodes()[this.index ?? 0];
  }

  async count() {
    return this.index === undefined ? this.nodes().length : this.node() ? 1 : 0;
  }
  nth(index: number) {
    return new FakeLocator(this.page, this.key, index);
  }
  first() {
    return this.nth(0);
  }
  last() {
    return this.nth(Math.max(0, this.nodes().length - 1));
  }
  async isVisible() {
    return this.node()?.visible ?? false;
  }
  async isEnabled() {
    return this.node()?.enabled ?? true;
  }
  async isEditable() {
    return this.node()?.editable ?? false;
  }
  async click() {
    this.page.clicks.push(this.key);
    this.node()?.onClick?.();
  }
  async fill(value: string) {
    this.page.fills.push({ key: this.key, value });
    this.node()?.onFill?.(value);
  }
  async getAttribute(name: string) {
    if (name === "title") return this.node()?.title ?? null;
    if (name === "lang") return this.node()?.text ?? null;
    return null;
  }
  async innerText() {
    return this.node()?.text ?? "";
  }
  async allInnerTexts() {
    return this.nodes().map((node) => node.text ?? "");
  }
  getByRole(role: string, options: { name?: string; exact?: boolean } = {}) {
    return new FakeLocator(
      this.page,
      `${this.key}>>role:${role}:${options.name ?? ""}:${String(options.exact ?? false)}`,
    );
  }
  getByText(text: string, options: { exact?: boolean } = {}) {
    return new FakeLocator(
      this.page,
      `${this.key}>>text:${text}:${String(options.exact ?? false)}`,
    );
  }
  locator(selector: string) {
    return new FakeLocator(this.page, `${this.key}>>css:${selector}`);
  }
  async waitFor() {}
  async screenshot() {}
  async setInputFiles(path: string) {
    this.page.files.push({ strategy: "input", path });
    this.node()?.onSetInputFiles?.(path);
  }
}

class FakePage {
  readonly nodes = new Map<string, FakeNode[]>();
  readonly clicks: string[] = [];
  readonly fills: Array<{ key: string; value: string }> = [];
  readonly files: Array<{ strategy: "chooser" | "input"; path: string }> = [];
  readonly fileChoosers: Array<null | {
    setFiles(path: string): Promise<void>;
  }> = [];
  onWait?: () => void;

  add(key: string, ...nodes: FakeNode[]) {
    this.nodes.set(key, nodes);
    return this;
  }
  locator(selector: string) {
    return new FakeLocator(this, `css:${selector}`);
  }
  getByRole(role: string, options: { name?: string; exact?: boolean } = {}) {
    return new FakeLocator(
      this,
      `role:${role}:${options.name ?? ""}:${String(options.exact ?? false)}`,
    );
  }
  getByText(text: string, options: { exact?: boolean } = {}) {
    return new FakeLocator(
      this,
      `text:${text}:${String(options.exact ?? false)}`,
    );
  }
  async goto() {}
  async waitForEvent(event: string) {
    if (event !== "filechooser") throw new Error("unsupported event");
    const chooser = this.fileChoosers.shift() ?? null;
    if (!chooser) throw new Error("no file chooser");
    return chooser;
  }
  async waitForTimeout() {
    this.onWait?.();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fileChooser(page: FakePage, onSet?: () => void) {
  return {
    setFiles: async (path: string) => {
      page.files.push({ strategy: "chooser", path });
      onSet?.();
    },
  };
}

function pageWithShell() {
  return new FakePage()
    .add("css:#side", { visible: true })
    .add("css:#pane-side", { visible: true })
    .add("css:html", { visible: true, text: "pt-BR" });
}

function adapter(page: FakePage, timeoutMs = 25) {
  return new PlaywrightWhatsAppWebPageAdapter(
    page as unknown as Page,
    timeoutMs,
    timeoutMs,
  );
}

function addVisibleSearchInput(page: FakePage, node: FakeNode = {}) {
  page.add("css:#side [contenteditable='true'][data-tab='3']", {
    visible: true,
    enabled: true,
    editable: true,
    ...node,
  });
}

function addSearchResults(page: FakePage) {
  page.add("css:#pane-side [role='listitem']", { visible: true });
}

describe("PlaywrightWhatsAppWebPageAdapter shell and global search", () => {
  it("waits for the authenticated shell to stabilize after loading", async () => {
    const page = new FakePage();
    let waits = 0;
    page.onWait = () => {
      waits += 1;
      if (waits === 1) page.add("css:#side", { visible: true });
    };
    await expect(
      adapter(page, 200).waitForAuthenticatedShell(),
    ).resolves.toMatchObject({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
    });
    expect(waits).toBeGreaterThanOrEqual(2);
  });

  it("uses a visible search textbox without requiring a trigger click", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    await expect(
      adapter(page).fillGlobalSearch("Grupo Exato"),
    ).resolves.toMatchObject({
      found: true,
      editable: true,
    });
    expect(page.clicks).toHaveLength(0);
    expect(page.fills.map(({ value }) => value)).toEqual(["", "Grupo Exato"]);
  });

  it("opens a search trigger found by accessible role", async () => {
    const page = pageWithShell();
    page.add("css:#side>>role:button:Search:true", {
      visible: true,
      enabled: true,
      onClick: () => addVisibleSearchInput(page),
    });
    await expect(adapter(page).openGlobalSearch()).resolves.toMatchObject({
      found: true,
      editable: true,
    });
    expect(page.clicks).toContain("css:#side>>role:button:Search:true");
  });

  it("rejects an invisible search input with a specific stage", async () => {
    const page = pageWithShell();
    page.add("css:#side [contenteditable='true'][data-tab='3']", {
      visible: false,
      enabled: true,
      editable: true,
    });
    await expect(adapter(page).findGlobalSearchInput()).resolves.toMatchObject({
      found: false,
      stage: "SEARCH_INPUT_NOT_VISIBLE",
    });
  });

  it("rejects a non-editable search input with a specific stage", async () => {
    const page = pageWithShell();
    page.add("css:#side [contenteditable='true'][data-tab='3']", {
      visible: true,
      enabled: true,
      editable: false,
    });
    await expect(adapter(page).findGlobalSearchInput()).resolves.toMatchObject({
      found: false,
      stage: "SEARCH_INPUT_NOT_EDITABLE",
    });
  });

  it("waits for the search results container and candidates", async () => {
    const page = pageWithShell();
    page.nodes.delete("css:#pane-side");
    let waits = 0;
    page.onWait = () => {
      waits += 1;
      if (waits === 1) page.add("css:#pane-side", { visible: true });
      if (waits === 2) addSearchResults(page);
    };
    await expect(
      adapter(page, 200).waitForSearchResults(),
    ).resolves.toMatchObject({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
    });
    expect(waits).toBe(2);
  });
});

describe("PlaywrightWhatsAppWebPageAdapter exact group fail-safe", () => {
  it("classifies partial-only results as GROUP_NOT_FOUND", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    addSearchResults(page);
    const result = await adapter(page).locateGroupExact("Grupo Exato");
    expect(result).toMatchObject({
      status: "GROUP_NOT_FOUND",
      exactMatch: false,
      stage: "EXACT_GROUP_RESULT_NOT_FOUND",
    });
  });

  it("classifies two indistinguishable exact results as GROUP_AMBIGUOUS", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    addSearchResults(page);
    page.add(
      `css:${whatsappWebExactGroupResultSelectors("Grupo Exato")[0]}`,
      { visible: true },
      { visible: true },
    );
    await expect(
      adapter(page).locateGroupExact("Grupo Exato"),
    ).resolves.toMatchObject({
      status: "GROUP_AMBIGUOUS",
      exactMatch: false,
      stage: "MULTIPLE_EXACT_GROUP_RESULTS",
    });
  });

  it("does not click an invisible exact candidate", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    addSearchResults(page);
    page.add(`css:${whatsappWebExactGroupResultSelectors("Grupo Exato")[0]}`, {
      visible: false,
      enabled: true,
    });
    await expect(
      adapter(page).locateGroupExact("Grupo Exato"),
    ).resolves.toMatchObject({
      status: "SELECTOR_MISMATCH",
      stage: "GROUP_RESULT_NOT_INTERACTABLE",
    });
    expect(page.clicks).toHaveLength(0);
  });

  it("opens only one exact visible result and validates header and composer", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    addSearchResults(page);
    const groupName = "Grupo Exato";
    page.add(`css:${whatsappWebExactGroupResultSelectors(groupName)[0]}`, {
      visible: true,
      enabled: true,
      onClick: () =>
        page.add(`css:${whatsappWebStableSelectors.conversationTitle[0]}`, {
          visible: true,
          title: groupName,
        }),
    });
    page.add(`css:${whatsappWebStableSelectors.composeBox[0]}`, {
      visible: true,
      enabled: true,
      editable: true,
    });
    const subject = adapter(page);
    await expect(subject.locateGroupExact(groupName)).resolves.toMatchObject({
      status: "GROUP_FOUND",
      exactMatch: true,
    });
    await subject.openGroup(groupName);
    await expect(subject.verifyOpenedGroup(groupName)).resolves.toBe(true);
    await expect(subject.verifyPublishPermission()).resolves.toBe(true);
    expect(page.fills).toEqual([
      expect.objectContaining({ value: "" }),
      expect.objectContaining({ value: groupName }),
    ]);
  });

  it("fails with GROUP_HEADER_MISMATCH after opening the wrong title", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    addSearchResults(page);
    const groupName = "Grupo Exato";
    page.add(`css:${whatsappWebExactGroupResultSelectors(groupName)[0]}`, {
      visible: true,
      enabled: true,
      onClick: () =>
        page.add(`css:${whatsappWebStableSelectors.conversationTitle[0]}`, {
          visible: true,
          title: "Outro grupo",
        }),
    });
    const subject = adapter(page, 100);
    await expect(subject.locateGroupExact(groupName)).resolves.toMatchObject({
      status: "GROUP_FOUND",
    });
    await expect(subject.openGroup(groupName)).rejects.toMatchObject({
      name: "WhatsAppWebStageError",
      stage: "GROUP_HEADER_MISMATCH",
    } satisfies Partial<WhatsAppWebStageError>);
  });

  it("returns false for a recognized read-only group", async () => {
    const page = pageWithShell();
    const readOnlySelector =
      whatsappWebStableSelectors.readOnlyFooter.join(",");
    page.add(`css:${readOnlySelector}`, { visible: true });
    page.add(
      `css:${readOnlySelector}>>text:Somente admins podem enviar mensagens:false`,
      { visible: true, text: "Somente admins podem enviar mensagens" },
    );
    await expect(adapter(page).verifyPublishPermission()).resolves.toBe(false);
  });

  it("reports COMPOSER_NOT_FOUND for an unknown composer structure", async () => {
    await expect(
      adapter(pageWithShell(), 10).verifyPublishPermission(),
    ).rejects.toMatchObject({
      name: "WhatsAppWebStageError",
      stage: "COMPOSER_NOT_FOUND",
    } satisfies Partial<WhatsAppWebStageError>);
  });

  it("keeps diagnostics structural and excludes candidate text", async () => {
    const page = pageWithShell();
    addVisibleSearchInput(page);
    addSearchResults(page);
    page.add("css:#pane-side [title]", {
      visible: true,
      title: "Nome privado de outra conversa",
    });
    const result = await adapter(page).locateGroupExact("Grupo Exato");
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain("Nome privado");
    expect(serialized).not.toContain("Grupo Exato");
    expect(result.diagnostics).toMatchObject({
      currentOrigin: "https://web.whatsapp.com",
      interfaceLanguage: "pt",
    });
  });
});

describe("PlaywrightWhatsAppWebPageAdapter media draft", () => {
  it("uploads through a direct file chooser and waits for preview", async () => {
    const page = pageWithShell();
    page.add("css:#main, main", { visible: true });
    page.add("css:#main footer button[aria-label*='attach' i]", {
      visible: true,
      enabled: true,
    });
    page.fileChoosers.push(
      fileChooser(page, () =>
        page.add("css:[data-testid='media-preview']", { visible: true }),
      ),
    );

    await expect(
      adapter(page).attachImage("C:\\temp\\offer.jpg"),
    ).resolves.toEqual({
      attachStrategyUsed: "DIRECT_FILE_CHOOSER",
      usedFileChooser: true,
      usedSetInputFiles: false,
      previewDetected: true,
    });
    expect(page.files).toEqual([
      { strategy: "chooser", path: "C:\\temp\\offer.jpg" },
    ]);
  });

  it("falls back to the semantic image file input and waits for preview", async () => {
    const page = pageWithShell();
    page.add("css:#main, main", { visible: true });
    page.add("css:#main footer button[aria-label*='attach' i]", {
      visible: true,
      enabled: true,
      onClick: () => {
        page.add("css:[role='menu']", { visible: true });
        page.add("css:input[type='file'][accept*='image']", {
          onSetInputFiles: () =>
            page.add("css:[data-testid='media-preview']", { visible: true }),
        });
      },
    });
    page.fileChoosers.push(null);

    await expect(
      adapter(page).attachImage("C:\\temp\\offer.jpg"),
    ).resolves.toEqual({
      attachStrategyUsed: "SET_INPUT_FILES",
      usedFileChooser: false,
      usedSetInputFiles: true,
      previewDetected: true,
    });
    expect(page.files[0]).toEqual({
      strategy: "input",
      path: "C:\\temp\\offer.jpg",
    });
  });

  it("preserves MEDIA_PREVIEW_NOT_FOUND instead of selector mismatch", async () => {
    const page = pageWithShell();
    page.add("css:#main, main", { visible: true });
    page.add("css:#main footer button[aria-label*='attach' i]", {
      visible: true,
      enabled: true,
    });
    page.fileChoosers.push(fileChooser(page));

    await expect(
      adapter(page, 10).attachImage("C:\\temp\\offer.jpg"),
    ).rejects.toMatchObject({
      stage: "MEDIA_PREVIEW_NOT_FOUND",
      errorCode: "WHATSAPP_WEB_MEDIA_UPLOAD_FAILED",
    });
  });

  it("preserves CAPTION_INPUT_NOT_FOUND", async () => {
    await expect(
      adapter(pageWithShell(), 10).fillCaption("draft"),
    ).rejects.toMatchObject({
      stage: "CAPTION_INPUT_NOT_FOUND",
      errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
    });
  });
});
