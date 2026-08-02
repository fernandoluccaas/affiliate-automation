import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  createChannelAction,
  confirmWhatsAppWebOwnershipAction,
  convertLegacyWhatsAppChannelAction,
  invalidateWhatsAppWebAuthorizationAction,
  setWhatsAppWebEnabledAction,
  setWhatsAppWebPausedAction,
  testTelegramChannelAction,
  toggleChannelAction,
  updateChannelAction,
} from "@/lib/actions";

export const dynamic = "force-dynamic";

type ChannelsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const channelTypes = [
  { value: "TELEGRAM", label: "Telegram", disabled: false },
  { value: "MANUAL_EXPORT", label: "Exportacao manual", disabled: false },
  { value: "WHATSAPP_GROUPS", label: "Grupo do WhatsApp", disabled: false },
  {
    value: "WHATSAPP_CHANNEL",
    label: "Canal do WhatsApp (legado)",
    disabled: true,
  },
  {
    value: "WHATSAPP_CLOUD_API",
    label: "WhatsApp Cloud API indisponivel",
    disabled: true,
  },
  {
    value: "WHATSAPP_GROUPS_API",
    label: "WhatsApp Groups API indisponivel",
    disabled: true,
  },
];

function listText(value: unknown) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function configChatId(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const chatId = (value as Record<string, unknown>).chatId;
    return typeof chatId === "string" ? chatId : "";
  }

  return "";
}

function configRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configText(value: unknown, key: string) {
  const field = configRecord(value)[key];
  return typeof field === "string" ? field : "";
}

function configNumber(value: unknown, key: string, fallback: number) {
  const field = configRecord(value)[key];
  return typeof field === "number" ? field : fallback;
}

function configBoolean(value: unknown, key: string, fallback: boolean) {
  const field = configRecord(value)[key];
  return typeof field === "boolean" ? field : fallback;
}

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "created") return "Canal criado.";
  if (value === "updated") return "Canal atualizado.";
  if (value === "enabled") return "Canal ativado.";
  if (value === "disabled") return "Canal desativado.";
  if (value === "telegram-ok") return "Integracao Telegram validada.";
  if (value === "telegram-failed") return "Falha ao validar Telegram.";
  if (value === "legacy-converted")
    return "Registro legado convertido para Grupo do WhatsApp sem alterar seu historico.";
  if (value === "web-ownership-confirmed")
    return "Propriedade/autorizacao do grupo confirmada.";
  if (value === "web-enabled")
    return "Modo Web experimental ativado para o grupo.";
  if (value === "web-disabled")
    return "Modo Web experimental desativado; fallback assistido restaurado.";
  if (value === "web-paused")
    return "Automacao Web pausada somente para este grupo.";
  if (value === "web-resumed") return "Automacao Web retomada para este grupo.";
  if (value === "web-invalidated")
    return "Autorizacao Web invalidada e modo assistido restaurado.";
  return null;
}

export default async function ChannelsPage({
  searchParams,
}: ChannelsPageProps) {
  const params = await searchParams;
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { publications: true } } },
  });
  const message = messageText(params?.message);

  return (
    <AdminShell currentPath="/canais" title="Canais">
      {message ? (
        <div className="rounded-md border bg-white px-4 py-3 text-sm">
          {message}
        </div>
      ) : null}

      <section className="rounded-md border bg-white p-4">
        <h2 className="text-base font-semibold">Novo canal</h2>
        <ChannelForm action={createChannelAction} submitLabel="Criar canal" />
      </section>

      {channels.length === 0 ? (
        <EmptyState
          title="Nenhum canal configurado"
          description="Crie um canal Telegram ou de exportacao manual para permitir o agendamento automatico."
        />
      ) : (
        <div className="grid gap-4">
          {channels.map((channel) => (
            <section
              key={channel.id}
              className="rounded-md border bg-white p-4"
            >
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold">{channel.name}</h2>
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {channel.type} - {channel.enabled ? "ativo" : "inativo"} -{" "}
                    {channel._count.publications} publicacao
                    {channel._count.publications === 1 ? "" : "es"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <form action={toggleChannelAction}>
                    <input type="hidden" name="id" value={channel.id} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={String(!channel.enabled)}
                    />
                    <Button variant="outline" type="submit">
                      {channel.enabled ? "Desativar" : "Ativar"}
                    </Button>
                  </form>
                  {channel.type === "TELEGRAM" ? (
                    <form action={testTelegramChannelAction}>
                      <input type="hidden" name="id" value={channel.id} />
                      <Button variant="outline" type="submit">
                        Testar Telegram
                      </Button>
                    </form>
                  ) : null}
                </div>
              </div>
              {channel.type === "WHATSAPP_CHANNEL" ? (
                <div className="grid gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
                  <p>
                    Este registro usa o tipo legado WHATSAPP_CHANNEL. Converta-o
                    explicitamente para Grupo do WhatsApp; o ID, as publicacoes
                    e os snapshots serao preservados.
                  </p>
                  <form action={convertLegacyWhatsAppChannelAction}>
                    <input type="hidden" name="id" value={channel.id} />
                    <Button type="submit">
                      Converter para Grupo do WhatsApp
                    </Button>
                  </form>
                </div>
              ) : (
                <ChannelForm
                  action={updateChannelAction}
                  submitLabel="Salvar alteracoes"
                  channel={{
                    id: channel.id,
                    name: channel.name,
                    type: channel.type,
                    enabled: channel.enabled,
                    timezone: channel.timezone,
                    dailyPublicationLimit: channel.dailyPublicationLimit,
                    minimumIntervalMinutes: channel.minimumIntervalMinutes,
                    allowedStartTime: channel.allowedStartTime ?? "",
                    allowedEndTime: channel.allowedEndTime ?? "",
                    minimumScore: channel.minimumScore,
                    minimumDiscountPercentage:
                      channel.minDiscountPercentage?.toString() ?? "",
                    productRepeatIntervalDays:
                      channel.productRepeatIntervalDays,
                    allowedMarketplaces: listText(channel.allowedMarketplaces),
                    allowedCategories: listText(channel.allowedCategories),
                    telegramChatId: configChatId(channel.configuration),
                    publicationMode:
                      configText(channel.configuration, "publicationMode") ||
                      "ASSISTED",
                    groupDisplayName: configText(
                      channel.configuration,
                      "groupDisplayName",
                    ),
                    customHeader: configText(
                      channel.configuration,
                      "customHeader",
                    ),
                    customFooter: configText(
                      channel.configuration,
                      "customFooter",
                    ),
                    sendImage: configBoolean(
                      channel.configuration,
                      "sendImage",
                      true,
                    ),
                    maxPendingPublications: configNumber(
                      channel.configuration,
                      "maxPendingPublications",
                      3,
                    ),
                    webProfileKey:
                      configText(channel.configuration, "webProfileKey") ||
                      "principal",
                  }}
                />
              )}
              {channel.type === "WHATSAPP_GROUPS" ? (
                <WhatsAppWebStatus
                  channelId={channel.id}
                  configuration={channel.configuration}
                />
              ) : null}
            </section>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

type ChannelFormValue = {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  timezone?: string;
  dailyPublicationLimit?: number;
  minimumIntervalMinutes?: number;
  allowedStartTime?: string;
  allowedEndTime?: string;
  minimumScore?: number;
  minimumDiscountPercentage?: string;
  productRepeatIntervalDays?: number;
  allowedMarketplaces?: string;
  allowedCategories?: string;
  telegramChatId?: string;
  publicationMode?: string;
  groupDisplayName?: string;
  customHeader?: string;
  customFooter?: string;
  sendImage?: boolean;
  maxPendingPublications?: number;
  webProfileKey?: string;
};

function ChannelForm({
  action,
  submitLabel,
  channel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  channel?: ChannelFormValue;
}) {
  return (
    <form action={action} className="mt-4 grid gap-4 md:grid-cols-3">
      {channel?.id ? (
        <input type="hidden" name="id" value={channel.id} />
      ) : null}
      <label className="grid gap-2">
        <Label>Nome</Label>
        <Input name="name" defaultValue={channel?.name ?? ""} required />
      </label>
      <label className="grid gap-2">
        <Label>Tipo</Label>
        <Select name="type" defaultValue={channel?.type ?? "TELEGRAM"}>
          {channelTypes.map((type) => (
            <option
              key={type.value}
              value={type.value}
              disabled={type.disabled}
            >
              {type.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-end gap-2 pb-2 text-sm font-medium">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={channel?.enabled ?? true}
        />
        Ativo
      </label>
      <label className="grid gap-2">
        <Label>Timezone</Label>
        <Input
          name="timezone"
          defaultValue={channel?.timezone ?? "America/Fortaleza"}
          required
        />
      </label>
      <label className="grid gap-2">
        <Label>Limite diario</Label>
        <Input
          name="dailyPublicationLimit"
          type="number"
          min="1"
          defaultValue={channel?.dailyPublicationLimit ?? 10}
        />
      </label>
      <label className="grid gap-2">
        <Label>Intervalo minimo (min)</Label>
        <Input
          name="minimumIntervalMinutes"
          type="number"
          min="0"
          defaultValue={channel?.minimumIntervalMinutes ?? 30}
        />
      </label>
      <label className="grid gap-2">
        <Label>Inicio permitido</Label>
        <Input
          name="allowedStartTime"
          type="time"
          defaultValue={channel?.allowedStartTime ?? ""}
        />
      </label>
      <label className="grid gap-2">
        <Label>Fim permitido</Label>
        <Input
          name="allowedEndTime"
          type="time"
          defaultValue={channel?.allowedEndTime ?? ""}
        />
      </label>
      <label className="grid gap-2">
        <Label>Score minimo</Label>
        <Input
          name="minimumScore"
          type="number"
          min="0"
          max="100"
          defaultValue={channel?.minimumScore ?? 70}
        />
        <span className="text-xs text-[var(--muted-foreground)]">
          Vazio ou 0 = sem minimo.
        </span>
      </label>
      <label className="grid gap-2">
        <Label>Desconto minimo (%)</Label>
        <Input
          name="minimumDiscountPercentage"
          type="number"
          min="0"
          max="100"
          step="0.01"
          defaultValue={channel?.minimumDiscountPercentage ?? ""}
        />
        <span className="text-xs text-[var(--muted-foreground)]">
          Vazio ou 0 = sem minimo.
        </span>
      </label>
      <label className="grid gap-2">
        <Label>Repeticao de produto (dias)</Label>
        <Input
          name="productRepeatIntervalDays"
          type="number"
          min="0"
          defaultValue={channel?.productRepeatIntervalDays ?? 7}
        />
      </label>
      <label className="grid gap-2">
        <Label>Marketplaces permitidos</Label>
        <Input
          name="allowedMarketplaces"
          placeholder="SHOPEE, MERCADO_LIVRE"
          defaultValue={channel?.allowedMarketplaces ?? ""}
        />
      </label>
      <label className="grid gap-2">
        <Label>Categorias permitidas</Label>
        <Input
          name="allowedCategories"
          placeholder="Casa, Eletronicos"
          defaultValue={channel?.allowedCategories ?? ""}
        />
        <span className="text-xs text-[var(--muted-foreground)]">
          Vazio = todas as categorias.
        </span>
      </label>
      <label className="grid gap-2">
        <Label>Telegram Chat ID</Label>
        <Input
          name="telegramChatId"
          defaultValue={channel?.telegramChatId ?? ""}
        />
      </label>
      <label className="grid gap-2">
        <Label>Modo WhatsApp</Label>
        <Select
          name="publicationMode"
          defaultValue={channel?.publicationMode ?? "ASSISTED"}
        >
          <option value="ASSISTED">Assistido (estavel)</option>
          <option value="WEB_EXPERIMENTAL">Web experimental (opcional)</option>
        </Select>
      </label>
      <label className="grid gap-2">
        <Label>Nome exato do Grupo</Label>
        <Input
          name="groupDisplayName"
          defaultValue={channel?.groupDisplayName ?? ""}
        />
      </label>
      <label className="grid gap-2">
        <Label>Perfil Web logico</Label>
        <Input
          name="webProfileKey"
          pattern="[A-Za-z0-9_-]+"
          defaultValue={channel?.webProfileKey ?? "principal"}
        />
        <span className="text-xs text-[var(--muted-foreground)]">
          Somente letras, numeros, hifen e underscore; nenhum path e exibido.
        </span>
      </label>
      <label className="grid gap-2">
        <Label>Maximo de pendencias assistidas</Label>
        <Input
          name="maxPendingPublications"
          type="number"
          min="1"
          max="50"
          defaultValue={channel?.maxPendingPublications ?? 3}
        />
        <span className="text-xs text-[var(--muted-foreground)]">
          Recomendado inicialmente: 3, com limite diario 3 e intervalo de 60
          minutos.
        </span>
      </label>
      <label className="grid gap-2 md:col-span-3">
        <Label>Cabecalho personalizado</Label>
        <Input name="customHeader" defaultValue={channel?.customHeader ?? ""} />
      </label>
      <label className="grid gap-2 md:col-span-3">
        <Label>Rodape personalizado</Label>
        <Input name="customFooter" defaultValue={channel?.customFooter ?? ""} />
      </label>
      <label className="flex items-end gap-2 pb-2 text-sm font-medium">
        <input
          name="sendImage"
          type="checkbox"
          defaultChecked={channel?.sendImage ?? true}
        />
        Preparar imagem
      </label>
      <div className="md:col-span-3">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

function WhatsAppWebStatus({
  channelId,
  configuration,
}: {
  channelId: string;
  configuration: unknown;
}) {
  const config = configRecord(configuration);
  const enabled = config.webAutomationEnabled === true;
  const ownership = config.webAutomationOwnershipConfirmed === true;
  const paused = config.webAutomationPaused === true;
  const session =
    configText(configuration, "webLastHealthStatus") || "NOT_INITIALIZED";
  const group =
    configText(configuration, "webLastGroupLocationStatus") || "NOT_CHECKED";
  const dryRun =
    configText(configuration, "webLastDryRunStatus") || "NUNCA EXECUTADO";
  const lastError = configText(configuration, "webLastError") || "Nenhum";

  return (
    <div className="mt-4 grid gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
      <p className="font-semibold">WhatsApp Groups Web experimental</p>
      <div className="grid gap-1 md:grid-cols-2">
        <p>Web experimental: {enabled ? "ATIVADO" : "DESATIVADO"}</p>
        <p>Ownership: {ownership ? "CONFIRMADA" : "NAO CONFIRMADA"}</p>
        <p>
          Perfil: {configText(configuration, "webProfileKey") || "principal"}
        </p>
        <p>Sessao: {session}</p>
        <p>Grupo: {group}</p>
        <p>Dry run: {dryRun}</p>
        <p>
          Ultima tentativa:{" "}
          {configText(configuration, "webLastAttemptAt") || "Nunca"}
        </p>
        <p>
          Ultimo sucesso:{" "}
          {configText(configuration, "webLastSuccessAt") || "Nunca"}
        </p>
        <p>Ultimo erro/rootCause: {lastError}</p>
        <p>
          Pausa:{" "}
          {paused
            ? configText(configuration, "webAutomationPauseReason") || "PAUSADO"
            : "NAO"}
        </p>
      </div>
      <p>
        Login, health, localizacao e dry run sao executados apenas pelos
        comandos locais documentados; o dashboard nunca abre Chromium nem recebe
        QR, cookies ou storage.
      </p>
      <div className="flex flex-wrap gap-2">
        {!ownership ? (
          <form
            action={confirmWhatsAppWebOwnershipAction}
            className="flex items-center gap-2"
          >
            <input type="hidden" name="id" value={channelId} />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="ownershipConfirmed" required />
              Confirmo que pertenco ou administro este grupo e estou autorizado
              a publicar nele.
            </label>
            <Button type="submit" variant="outline">
              Confirmar
            </Button>
          </form>
        ) : null}
        <form action={setWhatsAppWebEnabledAction}>
          <input type="hidden" name="id" value={channelId} />
          <input type="hidden" name="enabled" value={String(!enabled)} />
          <Button type="submit" variant="outline">
            {enabled
              ? "Desativar modo experimental"
              : "Ativar modo experimental"}
          </Button>
        </form>
        <form action={setWhatsAppWebPausedAction}>
          <input type="hidden" name="id" value={channelId} />
          <input type="hidden" name="paused" value={String(!paused)} />
          <Button type="submit" variant="outline">
            {paused ? "Retomar" : "Pausar"}
          </Button>
        </form>
        <form action={invalidateWhatsAppWebAuthorizationAction}>
          <input type="hidden" name="id" value={channelId} />
          <Button type="submit" variant="outline">
            Invalidar autorizacao Web
          </Button>
        </form>
      </div>
    </div>
  );
}
