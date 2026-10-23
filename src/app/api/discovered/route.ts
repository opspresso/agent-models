import { authorize, errorResponse } from "../../../lib/http.ts";
import { RouterError } from "../../../domain/router/errors.ts";

export async function GET(request: Request) {
  try {
    const { app, principal } = await authorize(request, "models:manage", true);
    const query = new URL(request.url).searchParams;
    const provider = query.get("provider");
    if (!provider) throw new RouterError("invalid_provider", 400, "Select a provider");
    return Response.json(await app.management.discovered(principal, provider, Number(query.get("limit") ?? "100"), query.get("after") ?? undefined), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
