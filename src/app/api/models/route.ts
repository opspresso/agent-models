import { authorize, errorResponse, jsonBody } from "../../../lib/http.ts";
import { modelInput } from "../../../lib/schemas.ts";
import { RouterError } from "../../../domain/router/errors.ts";
import type { SelectedModel } from "../../../domain/router/types.ts";
import { requireScope } from "../../../domain/identity.ts";

export async function GET(request: Request) {
  try {
    const { app, principal } = await authorize(request, "models:read");
    const all = new URL(request.url).searchParams.get("all") === "true";
    if (all) requireScope(principal, "models:manage");
    return Response.json(await app.management.models(principal, all), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    const { app, principal } = await authorize(request, "models:manage", true);
    const parsed = modelInput.safeParse(await jsonBody(request));
    if (!parsed.success) throw new RouterError("invalid_model", 400, "Model selection is invalid");
    // JSON cannot carry explicit undefined values admitted by Zod's optional output type.
    return Response.json(await app.management.saveModel(principal, parsed.data.model as Omit<SelectedModel, "revision" | "updatedAt">, parsed.data.revision), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
