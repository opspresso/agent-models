import { authorize, errorResponse, jsonBody } from "../../../lib/http.ts";
import { providerInput } from "../../../lib/schemas.ts";
import { RouterError } from "../../../domain/router/errors.ts";

export async function GET(request: Request) {
  try { const { app, principal } = await authorize(request, "models:manage", true); return Response.json(await app.management.providers(principal), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    const { app, principal } = await authorize(request, "models:manage", true);
    const parsed = providerInput.safeParse(await jsonBody(request));
    if (!parsed.success) throw new RouterError("invalid_provider", 400, "Provider configuration is invalid");
    const { secret, ...provider } = parsed.data.provider;
    return Response.json(await app.management.saveProvider(principal, { ...provider, ...(secret !== undefined ? { secret } : {}) }, parsed.data.revision), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
