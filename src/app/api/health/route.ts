import metadata from "../../../../package.json" with { type: "json" };
export function GET() { return Response.json({ status: "ok", service: "agent-models", version: metadata.version }); }
