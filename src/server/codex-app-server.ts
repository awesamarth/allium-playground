import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type CodexLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type CodexSessionStatus =
  | { state: "starting" }
  | { state: "awaiting_login"; login: CodexLogin }
  | { state: "connected"; planType: string | null }
  | { state: "error"; message: string };

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

type WalletTransactionsArguments = {
  address: string;
  chain: "base" | "ethereum";
  limit: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class CodexAppServer {
  readonly id = randomUUID();
  readonly home = join(tmpdir(), `allium-codex-${this.id}`);
  readonly workspace = join(this.home, "workspace");
  status: CodexSessionStatus = { state: "starting" };
  lastUsedAt = Date.now();

  private approvedWalletTransactions: WalletTransactionsArguments | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private lastAgentMessage = "";
  private turnResolver: ((text: string) => void) | null = null;
  private turnRejecter: ((error: Error) => void) | null = null;
  private turnDeltaHandler: ((delta: string) => void) | null = null;

  async start() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    await chmod(this.workspace, 0o700);
    this.process = spawn(/* turbopackIgnore: true */ process.env.CODEX_BIN ?? "codex", ["app-server"], {
      cwd: this.workspace,
      env: { ...process.env, CODEX_HOME: this.home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.onMessage(JSON.parse(line) as RpcMessage));
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code) => {
      if (code && this.status.state !== "error") {
        this.fail(new Error(`Codex app-server exited with code ${code}.`));
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "allium_playground",
        title: "Allium Playground",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});

    const account = (await this.request("account/read", {
      refreshToken: false,
    })) as { account?: { type?: string; planType?: string | null } | null };

    if (account.account) {
      await this.hardenAuthPermissions();
      this.status = {
        state: "connected",
        planType: account.account.planType ?? null,
      };
      return;
    }

    const login = (await this.request("account/login/start", {
      type: "chatgptDeviceCode",
    })) as CodexLogin & { type: string };
    this.status = {
      state: "awaiting_login",
      login: {
        loginId: login.loginId,
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
      },
    };
  }

  async plan(query: string, onDelta?: (delta: string) => void) {
    this.touch();
    if (this.status.state !== "connected") {
      throw new Error("Connect Codex before creating a plan.");
    }

    const thread = (await this.request("thread/start", {
      cwd: this.workspace,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions:
        "You plan Allium API calls. Never use shell or filesystem tools. Return only the requested JSON. Available paid tools: allium_wallet_transactions ($0.03), allium_wallet_balances ($0.03), allium_token_prices ($0.02), allium_token_price_history ($0.02). Use the fewest calls. Do not invent unsupported tools. For allium_wallet_transactions, arguments must contain address (an EVM 0x address), chain (base or ethereum), and limit (1-100 upstream transactions). Known alias: Binance 14 is 0x28C6c06298d514Db089934071355E5743bf21d60 on Ethereum. Resolve only that documented alias or an address explicitly supplied by the user; never invent an address. If a required wallet or chain cannot be determined, return no calls and explain the missing information in unsupportedParts.",
    })) as { thread: { id: string } };

    const outputSchema = {
      type: "object",
      properties: {
        interpretation: { type: "string" },
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                enum: [
                  "allium_wallet_transactions",
                  "allium_wallet_balances",
                  "allium_token_prices",
                  "allium_token_price_history",
                ],
              },
              arguments: {
                type: "object",
                properties: {
                  address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
                  chain: { type: "string", enum: ["base", "ethereum"] },
                  limit: { type: "integer", minimum: 1, maximum: 100 },
                },
                required: ["address", "chain", "limit"],
                additionalProperties: false,
              },
              reason: { type: "string" },
              unitCostUsd: { type: "number" },
              maxCalls: { type: "integer", enum: [1] },
            },
            required: ["tool", "arguments", "reason", "unitCostUsd", "maxCalls"],
            additionalProperties: false,
          },
        },
        assumptions: { type: "array", items: { type: "string" } },
        unsupportedParts: { type: "array", items: { type: "string" } },
      },
      required: ["interpretation", "calls", "assumptions", "unsupportedParts"],
      additionalProperties: false,
    };

    if (this.turnResolver) throw new Error("A Codex turn is already running.");
    const result = new Promise<string>((resolve, reject) => {
      this.lastAgentMessage = "";
      this.turnResolver = resolve;
      this.turnRejecter = reject;
      this.turnDeltaHandler = onDelta ?? null;
    });

    await this.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: query }],
      outputSchema,
    });

    const text = await Promise.race([
      result,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Codex planning timed out.")), 90_000),
      ),
    ]);
    return JSON.parse(text) as unknown;
  }

  approveWalletTransactions(arguments_: WalletTransactionsArguments) {
    this.approvedWalletTransactions = { ...arguments_ };
    this.touch();
  }

  permitsWalletTransactions(arguments_: WalletTransactionsArguments) {
    this.touch();
    const approved = this.approvedWalletTransactions;
    return Boolean(
      approved &&
        approved.address.toLowerCase() === arguments_.address.toLowerCase() &&
        approved.chain === arguments_.chain &&
        approved.limit === arguments_.limit,
    );
  }

  touch() {
    this.lastUsedAt = Date.now();
  }

  async close() {
    if (this.process?.stdin.writable && this.status.state === "connected") {
      await this.request("account/logout", {}).catch(() => undefined);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex session closed."));
    }
    this.pending.clear();
    this.process?.kill("SIGTERM");
    this.process = null;
    await rm(this.home, { recursive: true, force: true });
  }

  private request(method: string, params: Record<string, unknown>) {
    this.touch();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.send({ method, params });
  }

  private send(message: RpcMessage) {
    if (!this.process?.stdin.writable) {
      throw new Error("Codex app-server is unavailable.");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onMessage(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "account/login/completed") {
      const params = message.params as { success?: boolean; error?: string | null };
      this.status = params.success
        ? { state: "connected", planType: null }
        : { state: "error", message: params.error ?? "Codex login failed." };
      if (params.success) void this.hardenAuthPermissions().catch((error) => this.fail(error));
      return;
    }

    if (message.method === "account/updated") {
      const params = message.params as { authMode?: string | null; planType?: string | null };
      if (params.authMode === "chatgpt") {
        this.status = { state: "connected", planType: params.planType ?? null };
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const delta = (message.params as { delta?: string }).delta;
      if (delta) this.turnDeltaHandler?.(delta);
      return;
    }

    if (message.method === "item/completed") {
      const item = (message.params as { item?: { type?: string; text?: string } }).item;
      if (item?.type === "agentMessage" && item.text) this.lastAgentMessage = item.text;
      return;
    }

    if (message.method === "turn/completed") {
      const turn = (message.params as { turn?: { status?: string; error?: { message?: string } } }).turn;
      if (turn?.status === "completed" && this.lastAgentMessage) {
        this.turnResolver?.(this.lastAgentMessage);
      } else {
        this.turnRejecter?.(
          new Error(turn?.error?.message ?? "Codex could not complete the plan."),
        );
      }
      this.turnResolver = null;
      this.turnRejecter = null;
      this.turnDeltaHandler = null;
    }
  }

  private async hardenAuthPermissions() {
    await chmod(this.home, 0o700);
    await chmod(join(this.home, "auth.json"), 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private fail(error: Error) {
    this.status = { state: "error", message: error.message };
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.turnRejecter?.(error);
    this.turnResolver = null;
    this.turnRejecter = null;
    this.turnDeltaHandler = null;
  }
}
