import { authorize, errorResponse } from "../../../lib/http.ts";
import { usageQuery } from "../../../lib/schemas.ts";
import { RouterError } from "../../../domain/router/errors.ts";
import type { UsageQuery } from "../../../domain/router/types.ts";

export async function GET(request: Request) {
  try {
    const { app, principal } = await authorize(request, "usage:read");
    const parsed = usageQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new RouterError("invalid_usage_query", 400, "Invalid usage filters");
    return Response.json(await app.management.usageOverview(principal, parsed.data as UsageQuery), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
