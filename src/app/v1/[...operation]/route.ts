import { inferenceResponse } from "../../../lib/inference-http.ts";
import { authorize, errorResponse } from "../../../lib/http.ts";
import { RouterError } from "../../../domain/router/errors.ts";

type Context = { params: Promise<{ operation: string[] }> };
export async function POST(request: Request, context: Context) {
  try { return await inferenceResponse(request, (await context.params).operation.join("/")); }
  catch (error) { return errorResponse(error); }
}
export async function GET(request: Request, context: Context) {
  try {
    if ((await context.params).operation.join("/") !== "models") throw new RouterError("operation_not_found", 404, "API operation is not supported");
    const { app, principal } = await authorize(request, "models:read");
    const models = await app.management.models(principal);
    return Response.json({ object: "list", data: models.map(model => ({ ...model, object: "model", created: Math.floor(Date.parse(model.updatedAt) / 1000), owned_by: model.providerId })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
