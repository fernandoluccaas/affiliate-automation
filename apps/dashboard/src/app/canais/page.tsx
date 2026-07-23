import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  createChannelAction,
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
  { value: "WHATSAPP_CLOUD_API", label: "WhatsApp Cloud API indisponivel", disabled: true },
  { value: "WHATSAPP_GROUPS_API", label: "WhatsApp Groups API indisponivel", disabled: true },
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

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "created") return "Canal criado.";
  if (value === "updated") return "Canal atualizado.";
  if (value === "enabled") return "Canal ativado.";
  if (value === "disabled") return "Canal desativado.";
  if (value === "telegram-ok") return "Integracao Telegram validada.";
  if (value === "telegram-failed") return "Falha ao validar Telegram.";
  return null;
}

export default async function ChannelsPage({ searchParams }: ChannelsPageProps) {
  const params = await searchParams;
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { publications: true } } },
  });
  const message = messageText(params?.message);

  return (
    <AdminShell currentPath="/canais" title="Canais">
      {message ? (
        <div className="rounded-md border bg-white px-4 py-3 text-sm">{message}</div>
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
            <section key={channel.id} className="rounded-md border bg-white p-4">
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
                    <input type="hidden" name="enabled" value={String(!channel.enabled)} />
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
                  minimumDiscountPercentage: channel.minDiscountPercentage?.toString() ?? "",
                  productRepeatIntervalDays: channel.productRepeatIntervalDays,
                  allowedMarketplaces: listText(channel.allowedMarketplaces),
                  allowedCategories: listText(channel.allowedCategories),
                  telegramChatId: configChatId(channel.configuration),
                }}
              />
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
      {channel?.id ? <input type="hidden" name="id" value={channel.id} /> : null}
      <label className="grid gap-2">
        <Label>Nome</Label>
        <Input name="name" defaultValue={channel?.name ?? ""} required />
      </label>
      <label className="grid gap-2">
        <Label>Tipo</Label>
        <Select name="type" defaultValue={channel?.type ?? "TELEGRAM"}>
          {channelTypes.map((type) => (
            <option key={type.value} value={type.value} disabled={type.disabled}>
              {type.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-end gap-2 pb-2 text-sm font-medium">
        <input name="enabled" type="checkbox" defaultChecked={channel?.enabled ?? true} />
        Ativo
      </label>
      <label className="grid gap-2">
        <Label>Timezone</Label>
        <Input name="timezone" defaultValue={channel?.timezone ?? "America/Fortaleza"} required />
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
        <Input name="allowedStartTime" type="time" defaultValue={channel?.allowedStartTime ?? ""} />
      </label>
      <label className="grid gap-2">
        <Label>Fim permitido</Label>
        <Input name="allowedEndTime" type="time" defaultValue={channel?.allowedEndTime ?? ""} />
      </label>
      <label className="grid gap-2">
        <Label>Score minimo</Label>
        <Input name="minimumScore" type="number" min="0" max="100" defaultValue={channel?.minimumScore ?? 70} />
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
        <Input name="allowedMarketplaces" placeholder="SHOPEE, MERCADO_LIVRE" defaultValue={channel?.allowedMarketplaces ?? ""} />
      </label>
      <label className="grid gap-2">
        <Label>Categorias permitidas</Label>
        <Input name="allowedCategories" placeholder="Casa, Eletronicos" defaultValue={channel?.allowedCategories ?? ""} />
      </label>
      <label className="grid gap-2">
        <Label>Telegram Chat ID</Label>
        <Input name="telegramChatId" defaultValue={channel?.telegramChatId ?? ""} />
      </label>
      <div className="md:col-span-3">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
