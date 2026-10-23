import { runtime } from "../../../../lib/runtime.ts";
import { errorResponse } from "../../../../lib/http.ts";

async function handler(request: Request) {
  try { return await (await runtime()).auth.handler(request); }
  catch (error) { return errorResponse(error); }
}
export const GET = handler;
export const POST = handler;
