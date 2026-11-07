import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { login, refresh, type Tokens } from "skylight-mcp/auth";

export const DEFAULT_BASE_URL = "https://app.ourskylight.com/api";
const SKEW_MS = 60_000;

export interface Config {
  baseUrl: string;
  authBaseUrl: string;
  email?: string;
  password?: string;
  refreshToken?: string;
  frameId?: string;
}

const clean = (v: string | undefined) => {
  const t = v?.trim();
  return t && t !== "undefined" && t !== "null" && !t.startsWith("${") ? t : undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const email = clean(env.SKYLIGHT_EMAIL);
  const password = clean(env.SKYLIGHT_PASSWORD);
  const refreshToken = clean(env.SKYLIGHT_REFRESH_TOKEN);
  if (!refreshToken && (!email || !password)) {
    throw new AxiError(
      !email && !password
        ? "no Skylight credentials configured"
        : `missing ${email ? "SKYLIGHT_PASSWORD" : "SKYLIGHT_EMAIL"}`,
      "NO_AUTH",
      ["set SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD (or SKYLIGHT_REFRESH_TOKEN) in the environment"],
    );
  }
  const baseUrl = (clean(env.SKYLIGHT_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return {
    baseUrl,
    authBaseUrl: new URL(baseUrl).origin,
    email,
    password,
    refreshToken,
    frameId: clean(env.SKYLIGHT_FRAME_ID),
  };
}

interface Stored extends Tokens {
  expiresAt: number;
  /** Salted digest of the credential that minted the pair; a change invalidates the cache. */
  bound: string;
}

export function tokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    clean(env.SKYLIGHT_TOKEN_FILE) ??
    join(clean(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config"), "skylight-axi", "tokens.json")
  );
}

const bind = (c: Config) =>
  createHash("sha256")
    .update(c.refreshToken ? `r\0${c.refreshToken}` : `p\0${c.email?.toLowerCase()}\0${c.password}`)
    .digest("hex");

async function load(file: string, bound: string): Promise<Stored | undefined> {
  try {
    const s = JSON.parse(await readFile(file, "utf8")) as Stored;
    return s.accessToken && s.bound === bound ? s : undefined;
  } catch {
    return undefined;
  }
}

async function save(file: string, s: Stored): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

const toStored = (t: Tokens, bound: string, prev?: Stored): Stored => ({
  accessToken: t.accessToken,
  // Skylight rotates refresh tokens; keep the old one only if none came back.
  refreshToken: t.refreshToken || prev?.refreshToken || "",
  expiresInMs: t.expiresInMs,
  expiresAt: Date.now() + t.expiresInMs,
  bound,
});

/** Lazily-authenticating bearer-token source with an on-disk cache. */
export class Auth {
  private cur?: Stored;
  private inflight?: Promise<string>;
  constructor(
    private readonly cfg: Config,
    private readonly file = tokenFile(),
  ) {}

  /** A valid access token (refreshing/logging in only when needed). */
  token(): Promise<string> {
    return (this.inflight ??= this.resolve().finally(() => (this.inflight = undefined)));
  }

  /** Force a new token (after a 401). */
  async renew(): Promise<string> {
    if (this.cur) this.cur = { ...this.cur, expiresAt: 0 };
    return this.token();
  }

  private async resolve(): Promise<string> {
    const bound = bind(this.cfg);
    this.cur ??= await load(this.file, bound);
    if (this.cur && this.cur.expiresAt - SKEW_MS > Date.now()) return this.cur.accessToken;

    let tokens: Tokens;
    const rt = this.cur?.refreshToken || this.cfg.refreshToken;
    const canLogin = this.cfg.email && this.cfg.password;
    const doLogin = () =>
      login({ authBaseUrl: this.cfg.authBaseUrl, email: this.cfg.email!, password: this.cfg.password! });
    try {
      tokens = rt ? await refresh({ authBaseUrl: this.cfg.authBaseUrl, refreshToken: rt }) : await doLogin();
    } catch (e) {
      if (!rt || !canLogin) throw this.authError(e, !!rt);
      try {
        tokens = await doLogin();
      } catch (e2) {
        throw this.authError(e2, false);
      }
    }
    this.cur = toStored(tokens, bound, this.cur);
    try {
      await save(this.file, this.cur);
    } catch (e) {
      // Refresh tokens are single-use: warn loudly that the rotated one wasn't kept.
      process.stderr.write(`warning: could not cache tokens at ${this.file}: ${(e as Error).message}\n`);
    }
    return this.cur.accessToken;
  }

  private authError(e: unknown, usedRefresh: boolean): AxiError {
    const detail = e instanceof Error ? e.message.slice(0, 200) : String(e);
    return new AxiError(
      usedRefresh
        ? "Skylight rejected the refresh token (expired, revoked, or already used)"
        : `Skylight login failed: ${detail}`,
      "AUTH_FAILED",
      usedRefresh
        ? ["set SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD so a new token can be minted, or supply a fresh SKYLIGHT_REFRESH_TOKEN"]
        : ["check SKYLIGHT_EMAIL / SKYLIGHT_PASSWORD"],
    );
  }

  status(): { source: string; cache: string } {
    return {
      source: this.cfg.refreshToken ? "SKYLIGHT_REFRESH_TOKEN" : "SKYLIGHT_EMAIL/PASSWORD",
      cache: this.file,
    };
  }
}
