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
  attached?: boolean;
  tag?: string;
  role?: string | null;
  contentEditable?: string | null;
  ariaHidden?: boolean;
  insideOverlay?: boolean;
  topmost?: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  accessibleText?: string;
  trialError?: string;
  focusable?: boolean;
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
  async click(options?: { trial?: boolean }) {
    if (options?.trial && this.node()?.trialError) {
      throw new Error(this.node()?.trialError);
    }
    if (options?.trial) return;
    this.page.clicks.push(this.key);
    if (this.node()?.editable && this.node()?.focusable !== false)
      this.page.activeNode = this.node() ?? null;
    this.node()?.onClick?.();
  }
  async focus() {
    if (this.node()?.focusable !== false)
      this.page.activeNode = this.node() ?? null;
  }
  async fill(value: string) {
    this.page.fills.push({ key: this.key, value });
    this.node()?.onFill?.(value);
  }
  async getAttribute(name: string) {
    if (name === "title") return this.node()?.title ?? null;
    if (name === "lang") return this.node()?.text ?? null;
    if (name === "role") return this.node()?.role ?? null;
    if (name === "contenteditable") return this.node()?.contentEditable ?? null;
    if (name === "aria-hidden") return this.node()?.ariaHidden ? "true" : null;
    if (name === "aria-label" || name === "aria-placeholder")
      return this.node()?.accessibleText ?? null;
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
    if (selector.startsWith("xpath=ancestor")) {
      return new FakeLocator(this.page, "css:[data-testid='media-editor']");
    }
    return new FakeLocator(this.page, `${this.key}>>css:${selector}`);
  }
  async waitFor() {}
  async screenshot() {}
  async boundingBox() {
    if (this.node()?.boundingBox === null) return null;
    return (
      this.node()?.boundingBox ??
      (this.node()?.visible ? { x: 10, y: 10, width: 200, height: 40 } : null)
    );
  }
  async evaluate(_fn: unknown, argument?: { _node?: FakeNode }) {
    const source = String(_fn);
    const node = this.node();
    if (source.includes("root.contains")) {
      return argument?._node?.insideOverlay !== false;
    }
    if (source.includes("document.activeElement")) {
      return this.page.activeNode === node;
    }
    if (source.includes("elementFromPoint")) return node?.topmost !== false;
    return undefined;
  }
  async elementHandle() {
    const node = this.node();
    if (!node) return null;
    return {
      _node: node,
      evaluate: async (fn: unknown) => {
        const source = String(fn);
        if (source.includes("tagName")) {
          return {
            attached: node.attached !== false,
            tag: node.tag ?? "div",
            role: node.role ?? "textbox",
            contentEditable: node.contentEditable ?? "true",
            ariaHidden: node.ariaHidden ?? false,
            active: this.page.activeNode === node,
            accessibleTextLength: node.accessibleText?.length ?? 0,
          };
        }
        if (source.includes("elementFromPoint")) return node.topmost !== false;
        return node.attached !== false;
      },
      dispose: async () => undefined,
    };
  }
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
  readonly insertions: string[] = [];
  readonly fileChoosers: Array<null | {
    setFiles(path: string): Promise<void>;
  }> = [];
  onWait?: () => void;
  activeNode: FakeNode | null = null;
  readonly keyboard = {
    press: async (key: string) => {
      if (key === "Backspace" && this.activeNode) {
        this.activeNode.text = "";
        this.activeNode.onFill?.("");
      }
    },
    insertText: async (value: string) => {
      if (!this.activeNode) return;
      this.insertions.push(value);
      this.activeNode.text = value;
      this.activeNode.onFill?.(value);
    },
  };

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

  it("preserves CAPTION_NOT_INSIDE_MEDIA_OVERLAY", async () => {
    await expect(
      adapter(pageWithShell(), 10).fillCaption({
        text: "draft https://meli.la/abc",
        affiliateUrl: "https://meli.la/abc",
        textSnippet: "draft",
      }),
    ).rejects.toMatchObject({
      stage: "CAPTION_NOT_INSIDE_MEDIA_OVERLAY",
      errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
    });
  });
});

describe("PlaywrightWhatsAppWebPageAdapter media send trigger", () => {
  function mediaEditorPage() {
    return pageWithShell()
      .add("css:[data-testid='media-editor']", {
        visible: true,
      })
      .add("css:[data-testid='media-preview']", { visible: true })
      .add(
        "css:[data-testid='media-editor']>>css:[data-testid='media-preview']",
        { visible: true },
      )
      .add("css:[data-testid='media-editor']>>role:button:Close:true", {
        visible: true,
      });
  }

  it.each(["Enviar", "Send"])(
    "finds the %s role alias only inside the media editor",
    async (alias) => {
      const page = mediaEditorPage().add(
        `css:[data-testid='media-editor']>>role:button:${alias}:true`,
        { visible: true, enabled: true },
      );
      page.add(`role:button:${alias}:true`, {
        visible: true,
        enabled: true,
      });

      const result = await adapter(page).inspectSendTrigger({
        mediaExpected: true,
      });

      expect(result).toMatchObject({
        found: true,
        visible: true,
        enabled: true,
        candidateCount: 1,
        stage: "READY_TO_COMMIT_SEND",
      });
      expect(page.clicks).toEqual([]);
    },
  );

  it("falls back to a scoped aria-label selector", async () => {
    const page = mediaEditorPage().add(
      "css:[data-testid='media-editor']>>css:button[aria-label='Send']",
      { visible: true, enabled: true },
    );
    await expect(
      adapter(page).inspectSendTrigger({ mediaExpected: true }),
    ).resolves.toMatchObject({ found: true, strategiesTried: 3 });
  });

  it("reports a send trigger intercepted during trial click", async () => {
    const page = mediaEditorPage().add(
      "css:[data-testid='media-editor']>>role:button:Enviar:true",
      {
        visible: true,
        enabled: true,
        trialError: "another element intercepts pointer events",
      },
    );
    await expect(
      adapter(page).inspectSendTrigger({ mediaExpected: true }),
    ).resolves.toMatchObject({
      stage: "SEND_TRIGGER_INTERCEPTED",
      trialClickSucceeded: false,
    });
    expect(page.clicks).toEqual([]);
  });

  it("rejects a send trigger that is not topmost", async () => {
    const page = mediaEditorPage().add(
      "css:[data-testid='media-editor']>>role:button:Enviar:true",
      { visible: true, enabled: true, topmost: false },
    );
    await expect(
      adapter(page).inspectSendTrigger({ mediaExpected: true }),
    ).resolves.toMatchObject({ stage: "SEND_TRIGGER_NOT_TOPMOST" });
  });

  it.each([
    ["SEND_TRIGGER_NOT_FOUND", []],
    [
      "SEND_TRIGGER_AMBIGUOUS",
      [
        { visible: true, enabled: true },
        { visible: true, enabled: true },
      ],
    ],
    ["SEND_TRIGGER_NOT_VISIBLE", [{ visible: false, enabled: true }]],
    ["SEND_TRIGGER_DISABLED", [{ visible: true, enabled: false }]],
  ] as const)("returns %s without clicking", async (stage, nodes) => {
    const page = mediaEditorPage();
    if (nodes.length) {
      page.add(
        "css:[data-testid='media-editor']>>role:button:Enviar:true",
        ...nodes,
      );
    }

    await expect(
      adapter(page).inspectSendTrigger({ mediaExpected: true }),
    ).resolves.toMatchObject({ stage });
    expect(page.clicks).toEqual([]);
  });

  it("clicks only the trigger previously validated in the media editor", async () => {
    const page = mediaEditorPage().add(
      "css:[data-testid='media-editor']>>role:button:Enviar:true",
      { visible: true, enabled: true },
    );
    const pageAdapter = adapter(page);
    await pageAdapter.inspectSendTrigger({ mediaExpected: true });
    await pageAdapter.clickSendTrigger();
    expect(page.clicks).toEqual([
      "css:[data-testid='media-editor']>>role:button:Enviar:true",
    ]);
  });

  it("rejects a named page candidate outside the current media overlay", async () => {
    const page = mediaEditorPage().add("role:button:Enviar:true", {
      visible: true,
      enabled: true,
    });

    await expect(
      adapter(page).inspectSendTrigger({ mediaExpected: true }),
    ).resolves.toMatchObject({ stage: "SEND_TRIGGER_NOT_FOUND" });
  });
});

describe("PlaywrightWhatsAppWebPageAdapter stable media caption", () => {
  const captionKey =
    "css:[data-testid='media-editor']>>role:textbox:Add a caption:false";
  const captionInput = {
    text: "Oferta Produto https://meli.la/abc",
    affiliateUrl: "https://meli.la/abc",
    textSnippet: "Produto",
  };

  function stableCaptionPage(node: FakeNode) {
    node.visible ??= true;
    node.enabled ??= true;
    node.editable ??= true;
    node.attached ??= true;
    return pageWithShell()
      .add("css:[data-testid='media-editor']", { visible: true })
      .add("css:[data-testid='media-preview']", { visible: true })
      .add(
        "css:[data-testid='media-editor']>>css:[data-testid='media-preview']",
        { visible: true },
      )
      .add("css:[data-testid='media-editor']>>role:button:Send:true", {
        visible: true,
      })
      .add("css:[data-testid='media-editor']>>role:button:Close:true", {
        visible: true,
      })
      .add(captionKey, node);
  }

  it("fills and confirms a caption that remains stable", async () => {
    const node: FakeNode = {};
    node.onFill = (value) => {
      node.text = value;
    };
    await expect(
      adapter(stableCaptionPage(node), 200).fillCaption(captionInput),
    ).resolves.toMatchObject({
      captionFillAttempts: 1,
      captionStable: true,
      affiliateUrlOccurrenceCount: 1,
      titleSnippetConfirmed: true,
    });
  });

  it("rejects a semantic caption outside the active media overlay", async () => {
    const node: FakeNode = {
      visible: true,
      enabled: true,
      editable: true,
      attached: true,
    };
    node.onFill = (value) => {
      node.text = value;
    };
    const page = pageWithShell()
      .add("css:[data-testid='media-editor']", { visible: true })
      .add("css:[data-testid='media-preview']", { visible: true })
      .add("role:textbox:Adicionar uma legenda:false", node);

    await expect(
      adapter(page, 200).fillCaption(captionInput),
    ).rejects.toMatchObject({ stage: "CAPTION_VISUAL_TARGET_NOT_CONFIRMED" });
  });

  it("refills once when WhatsApp recreates the caption input", async () => {
    const first: FakeNode = {};
    const second: FakeNode = {};
    const page = stableCaptionPage(first);
    let replaceOnWait = false;
    first.onFill = (value) => {
      first.text = value;
      if (value) replaceOnWait = true;
    };
    second.onFill = (value) => {
      second.text = value;
    };
    page.onWait = () => {
      if (!replaceOnWait) return;
      replaceOnWait = false;
      first.attached = false;
      second.visible = true;
      second.enabled = true;
      second.editable = true;
      second.attached = true;
      page.add(captionKey, second);
    };

    await expect(
      adapter(page, 500).fillCaption(captionInput),
    ).resolves.toMatchObject({
      captionFillAttempts: 2,
      captionStable: true,
    });
  });

  it("reports CAPTION_CONTENT_LOST after two bounded fills", async () => {
    const node: FakeNode = {};
    let clearOnWait = false;
    node.onFill = (value) => {
      node.text = value;
      if (value) clearOnWait = true;
    };
    const page = stableCaptionPage(node);
    page.onWait = () => {
      if (clearOnWait) node.text = "";
      clearOnWait = false;
    };

    await expect(
      adapter(page, 500).fillCaption(captionInput),
    ).rejects.toMatchObject({ stage: "CAPTION_VISIBLE_TEXT_MISSING" });
  });

  it("reports CAPTION_CONTENT_MISMATCH for a persistent partial caption", async () => {
    const node: FakeNode = {};
    node.onFill = (value) => {
      node.text = value ? "Oferta parcial" : "";
    };
    await expect(
      adapter(stableCaptionPage(node), 500).fillCaption(captionInput),
    ).rejects.toMatchObject({ stage: "CAPTION_VISIBLE_TEXT_MISMATCH" });
  });

  it("reports CAPTION_CONTENT_MISMATCH when the URL is duplicated", async () => {
    const node: FakeNode = {};
    node.onFill = (value) => {
      node.text = value ? `${value} https://meli.la/abc` : "";
    };
    await expect(
      adapter(stableCaptionPage(node), 500).fillCaption(captionInput),
    ).rejects.toMatchObject({ stage: "CAPTION_VISIBLE_TEXT_MISMATCH" });
  });

  it("rejects a caption candidate with a zero-area bounding box", async () => {
    const node: FakeNode = { boundingBox: null };
    await expect(
      adapter(stableCaptionPage(node), 200).fillCaption(captionInput),
    ).rejects.toMatchObject({
      stage: "CAPTION_VISUAL_TARGET_NOT_CONFIRMED",
    });
  });

  it("rejects a caption candidate covered at its center", async () => {
    const node: FakeNode = { topmost: false };
    await expect(
      adapter(stableCaptionPage(node), 200).fillCaption(captionInput),
    ).rejects.toMatchObject({ stage: "CAPTION_NOT_TOPMOST" });
  });

  it("rejects a caption whose active element cannot be confirmed", async () => {
    const node: FakeNode = { focusable: false };
    await expect(
      adapter(stableCaptionPage(node), 200).fillCaption(captionInput),
    ).rejects.toMatchObject({ stage: "CAPTION_FOCUS_NOT_CONFIRMED" });
  });

  it("inserts the exact contenteditable snapshot with keyboard.insertText", async () => {
    const node: FakeNode = {};
    const page = stableCaptionPage(node);
    const exact = {
      ...captionInput,
      text: "*Oferta*\nAção com emoji 🔥\nhttps://meli.la/abc",
      textSnippet: "Ação com emoji",
    };
    node.onFill = (value) => {
      node.text = value;
    };
    await adapter(page, 200).fillCaption(exact);
    expect(page.insertions).toEqual([exact.text]);
  });

  it("rejects hidden snapshot text when the visible caption is empty", async () => {
    const hidden: FakeNode = {
      visible: false,
      editable: true,
      text: captionInput.text,
      topmost: false,
    };
    const visible: FakeNode = {
      visible: true,
      editable: true,
      text: "",
    };
    const page = stableCaptionPage(visible).add(captionKey, hidden, visible);
    page.activeNode = visible;
    await expect(
      adapter(page).inspectPreparedDraft({
        affiliateUrl: captionInput.affiliateUrl,
        textSnippet: captionInput.textSnippet,
        expectedText: captionInput.text,
        mediaExpected: true,
      }),
    ).rejects.toMatchObject({ stage: "CAPTION_HIDDEN_FALSE_POSITIVE" });
  });

  it("does not accept snapshot text from the normal composer behind the overlay", async () => {
    const visible: FakeNode = {
      visible: true,
      editable: true,
      text: "",
    };
    const page = stableCaptionPage(visible).add(
      "css:#main footer [contenteditable='true']",
      { visible: true, editable: true, text: captionInput.text },
    );
    page.activeNode = visible;
    await expect(
      adapter(page).inspectPreparedDraft({
        affiliateUrl: captionInput.affiliateUrl,
        textSnippet: captionInput.textSnippet,
        expectedText: captionInput.text,
        mediaExpected: true,
      }),
    ).rejects.toMatchObject({ stage: "CAPTION_VISIBLE_TEXT_MISSING" });
  });

  it("rejects equal visible length with different content", async () => {
    const visible: FakeNode = {
      visible: true,
      editable: true,
      text: captionInput.text.replace("Produto", "Produtx"),
    };
    const page = stableCaptionPage(visible);
    page.activeNode = visible;
    await expect(
      adapter(page).inspectPreparedDraft({
        affiliateUrl: captionInput.affiliateUrl,
        textSnippet: captionInput.textSnippet,
        expectedText: captionInput.text,
        mediaExpected: true,
      }),
    ).rejects.toMatchObject({ stage: "CAPTION_VISIBLE_TEXT_MISMATCH" });
  });
});

describe("PlaywrightWhatsAppWebPageAdapter visible draft text", () => {
  it("rejects hidden lexical text when the visible editable text differs", async () => {
    const page = pageWithShell()
      .add("css:[data-testid='media-editor']", { visible: true })
      .add(
        "css:[data-testid='media-editor']>>role:textbox:Add a caption:false",
        {
          visible: true,
          editable: true,
          text: "Oferta https://meli.la/abc Oferta https://meli.la/abc",
        },
      )
      .add(
        "css:[data-testid='media-editor']>>role:textbox:Add a caption:false>>css:[data-lexical-text='true']",
        { text: "Oferta https://meli.la/abc" },
      )
      .add("css:[data-testid='media-preview']", { visible: true });

    page.activeNode =
      page.nodes.get(
        "css:[data-testid='media-editor']>>role:textbox:Add a caption:false",
      )?.[0] ?? null;
    await expect(
      adapter(page).inspectPreparedDraft({
        affiliateUrl: "https://meli.la/abc",
        textSnippet: "Oferta",
        expectedText: "Oferta https://meli.la/abc",
        mediaExpected: true,
      }),
    ).rejects.toMatchObject({ stage: "CAPTION_VISIBLE_TEXT_MISMATCH" });
  });
});
