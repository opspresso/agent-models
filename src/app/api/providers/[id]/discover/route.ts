import { authorize, errorResponse } from "../../../../../lib/http.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { app, principal } = await authorize(request, "models:manage", true); return Response.json(await app.management.discover(principal, (await context.params).id)); }
  catch (error) { return errorResponse(error); }
}
