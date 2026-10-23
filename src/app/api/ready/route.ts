import { runtime } from "../../../lib/runtime.ts";
import { errorResponse } from "../../../lib/http.ts";

export async function GET() {
  try { await (await runtime()).pool.query("SELECT 1"); return Response.json({ status: "ready" }); }
  catch (error) { return errorResponse(error); }
}
