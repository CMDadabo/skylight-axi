import { AxiError } from "axi-sdk-js";

export type FlagKind = "string" | "boolean";
export interface Spec {
  /** Flags this command accepts (`--help` is always allowed by the SDK). */
  flags: Record<string, FlagKind>;
  /** Command usage line shown on usage errors. */
  usage: string;
  /** Renamed/removed flags -> hint. */
  renamed?: Record<string, string>;
}
export interface Parsed {
  pos: string[];
  flags: Record<string, string | boolean | undefined>;
}

export function usageError(message: string, usage: string): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", [usage]);
}

export function parseArgs(args: string[], spec: Spec): Parsed {
  const pos: string[] = [];
  const flags: Parsed["flags"] = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = spec.flags[name];
    if (!kind) {
      const hint = spec.renamed?.[name];
      const valid = Object.keys(spec.flags).map((f) => `--${f}`).join(", ") || "(none)";
      throw new AxiError(
        hint ? `--${name} was renamed; ${hint}` : `unknown flag --${name}`,
        "VALIDATION_ERROR",
        [`valid flags: ${valid}`, spec.usage],
      );
    }
    if (kind === "boolean") {
      flags[name] = eq === -1 ? true : eq !== -1 && a.slice(eq + 1) !== "false";
      continue;
    }
    const value = eq === -1 ? args[++i] : a.slice(eq + 1);
    if (value === undefined) throw usageError(`--${name} requires a value`, spec.usage);
    flags[name] = value;
  }
  return { pos, flags };
}

export const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function requireDate(v: string, flag: string, usage: string): string {
  if (!DATE.test(v)) throw usageError(`--${flag} must be YYYY-MM-DD (got "${v}")`, usage);
  return v;
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

/** Resolve --from/--to/--days into an inclusive range; default is today..today+defaultDays-1. */
export function dateRange(
  f: Parsed["flags"],
  usage: string,
  defaultDays: number,
): { from: string; to: string } {
  const from = str(f.from) ? requireDate(str(f.from)!, "from", usage) : localDate();
  let to: string;
  if (str(f.to)) to = requireDate(str(f.to)!, "to", usage);
  else if (str(f.days)) {
    const n = Number(f.days);
    if (!Number.isInteger(n) || n < 1) throw usageError("--days must be a positive integer", usage);
    to = addDays(from, n - 1);
  } else to = addDays(from, defaultDays - 1);
  if (to < from) throw usageError("--to must not be before --from", usage);
  return { from, to };
}

export function requirePosOrFail(pos: string[], n: number, usage: string, what: string): void {
  if (pos.length < n) throw usageError(`missing ${what}`, usage);
}

/** IANA zone for API queries: SKYLIGHT_TIMEZONE, else the machine's zone. */
export function localTimezone(): string {
  return process.env.SKYLIGHT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
