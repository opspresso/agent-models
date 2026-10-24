const ROUTER_ERROR = Symbol.for("opspresso.agent-models.router-error");

export class RouterError extends Error {
  readonly [ROUTER_ERROR] = true;
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.status = status;
  }
}

/** RSC and route bundles share runtime adapters but may load separate constructor instances. */
export function isRouterError(error: unknown): error is RouterError {
  return error instanceof Error && Reflect.get(error, ROUTER_ERROR) === true;
}

export function requireAdmin(admin: boolean): void {
  if (!admin) throw new RouterError("admin_required", 403, "Administrator access is required");
}
