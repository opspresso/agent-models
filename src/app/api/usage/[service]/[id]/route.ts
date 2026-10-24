import { authorizeReceipt, errorResponse } from "../../../../../lib/http.ts";

export async function GET(request: Request, context: { params: Promise<{ service: string; id: string }> }) {
  try { const { app, principal } = await authorizeReceipt(request); const { service, id } = await context.params;
    return Response.json(await app.management.requestUsage(principal, service, id), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
