export class RouterError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.status = status;
  }
}

export function requireAdmin(admin: boolean): void {
  if (!admin) throw new RouterError("admin_required", 403, "Administrator access is required");
}
