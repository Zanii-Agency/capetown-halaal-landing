/**
 * Structured logger for the CTH platform.
 *
 * Emits one JSON line per call to stdout/stderr so Vercel + log drains
 * can index by route, vendor_application_id, wa_phone, level, etc.
 *
 * Do not log secrets, raw tokens, full request bodies, or full message
 * payloads. Use `meta` for small, indexable scalars.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogContext {
  /** Route or job name, e.g. "api/whatsapp/inbound" or "cron/reminders". */
  route?: string;
  /** Vendor application id, when the log is scoped to one vendor. */
  vendor_application_id?: string;
  /** WhatsApp phone (E.164), when the log is scoped to one conversation. */
  wa_phone?: string;
  /** Free-form structured fields. Keep keys snake_case, values primitive. */
  meta?: Record<string, unknown>;
}

export interface LogEntry extends LogContext {
  level: LogLevel;
  msg: string;
  ts: string;
}

function serialise(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch {
    // Fall back to a safe shape if meta has a circular ref.
    return JSON.stringify({
      level: entry.level,
      msg: entry.msg,
      ts: entry.ts,
      route: entry.route,
      vendor_application_id: entry.vendor_application_id,
      wa_phone: entry.wa_phone,
      meta: { _serialise_error: true },
    });
  }
}

function emit(level: LogLevel, msg: string, ctx: LogContext = {}): void {
  const entry: LogEntry = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(ctx.route !== undefined ? { route: ctx.route } : {}),
    ...(ctx.vendor_application_id !== undefined
      ? { vendor_application_id: ctx.vendor_application_id }
      : {}),
    ...(ctx.wa_phone !== undefined ? { wa_phone: ctx.wa_phone } : {}),
    ...(ctx.meta !== undefined ? { meta: ctx.meta } : {}),
  };

  const line = serialise(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info(msg: string, ctx?: LogContext): void {
    emit("info", msg, ctx);
  },
  warn(msg: string, ctx?: LogContext): void {
    emit("warn", msg, ctx);
  },
  error(msg: string, ctx?: LogContext): void {
    emit("error", msg, ctx);
  },
};

/**
 * Bind a base context (e.g. route + vendor_application_id) and return a
 * scoped logger so call sites do not have to repeat the same fields.
 *
 *   const slog = scoped({ route: "cron/reminders" });
 *   slog.info("tick", { meta: { batch: 12 } });
 */
export function scoped(base: LogContext) {
  const merge = (ctx?: LogContext): LogContext => ({
    ...base,
    ...(ctx ?? {}),
    meta: {
      ...(base.meta ?? {}),
      ...(ctx?.meta ?? {}),
    },
  });

  return {
    info(msg: string, ctx?: LogContext): void {
      emit("info", msg, merge(ctx));
    },
    warn(msg: string, ctx?: LogContext): void {
      emit("warn", msg, merge(ctx));
    },
    error(msg: string, ctx?: LogContext): void {
      emit("error", msg, merge(ctx));
    },
  };
}
