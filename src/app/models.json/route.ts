import { publishedCatalog } from "../../lib/catalog.ts";
export function GET() { return Response.json(publishedCatalog(), { headers: { "cache-control": "public, max-age=900" } }); }
