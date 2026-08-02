import { prisma } from "@affiliate/database";
import { prepareRemoteImage } from "@affiliate/publisher-connectors";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await context.params;
  const publication = await prisma.publication.findFirst({
    where: { id, channel: { type: "WHATSAPP_GROUPS" } },
    select: { imageUrlSnapshot: true },
  });
  if (!publication?.imageUrlSnapshot) return new Response("Not found", { status: 404 });

  try {
    const image = await prepareRemoteImage(publication.imageUrlSnapshot, {
      timeoutMs: Number(process.env.WHATSAPP_MEDIA_TIMEOUT_MS ?? 10_000),
      maxBytes: Number(process.env.WHATSAPP_MEDIA_MAX_BYTES ?? 8 * 1024 * 1024),
    });
    const body = new Uint8Array(image.bytes).buffer;
    return new Response(body, {
      headers: {
        "Content-Type": image.contentType,
        "Content-Disposition": `${new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${image.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("Imagem indisponivel", { status: 422 });
  }
}
