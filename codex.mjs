import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class CodexRpc {
  constructor(child, timeout = 60_000) {
    this.child = child;
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.lines = createInterface({ input: child.stdout });
    // Codex diagnostics can contain private configuration; never forward stderr.
    child.stderr.resume();
    this.lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method) {
          if (message.id !== undefined) {
            this.notify({
              id: message.id,
              error: {
                code: -32601,
                message:
                  "Interactive requests are not supported by the Slack bridge",
              },
            });
          }
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        message.error
          ? request.reject(new Error(message.error.message))
          : request.resolve(message.result);
      } catch {
        this.close(new Error("Invalid JSON from Codex app-server"));
      }
    });
    child.once("error", () =>
      this.close(
        new Error(
          "Cannot start codex. Install Codex CLI and make it available on PATH.",
        ),
      ),
    );
    child.once("exit", () =>
      this.close(
        new Error(
          "Codex app-server exited. Check your Codex login and Slack connection.",
        ),
      ),
    );
    child.stdin.on("error", () =>
      this.close(new Error("Codex app-server input closed")),
    );
  }

  notify(message) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params, signal) {
    if (this.closed)
      return Promise.reject(new Error("Codex connection is closed"));
    if (signal?.aborted)
      return Promise.reject(new Error("Slack request cancelled"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        callback(value);
      };
      const abort = () => this.close(new Error("Slack request cancelled"));
      const timer = setTimeout(
        () => this.close(new Error(`Codex request timed out: ${method}`)),
        this.timeout,
      );
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.notify({ id, method, params });
    });
  }

  close(error = new Error("Codex connection closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.lines.close();
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1_000);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}

export function readOnlySlackTools(servers) {
  const tools = [];
  for (const server of servers) {
    for (const [name, tool] of Object.entries(server.tools ?? {})) {
      const isSlack =
        server.name.toLowerCase() === "slack" ||
        /^slack[._/-]/i.test(name) ||
        tool._meta?.connector_name?.toLowerCase() === "slack";
      if (!isSlack) continue;
      if (
        tool.annotations?.readOnlyHint !== true ||
        tool.annotations?.destructiveHint === true
      )
        continue;
      tools.push({
        name: `${server.name}/${name}`,
        server: server.name,
        tool: name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return tools;
}

/**
 * @template T
 * @param {(bridge: {rpc: CodexRpc, threadId: string, tools: ReturnType<typeof readOnlySlackTools>}) => Promise<T>} callback
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export async function withSlack(callback, signal) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-slack-codex-bridge-"));
  let rpc;
  try {
    signal?.throwIfAborted();
    rpc = new CodexRpc(
      spawn("codex", ["app-server", "--stdio"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "pi_slack_bridge", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      signal,
    );
    rpc.notify({ method: "initialized" });
    const { thread } = await rpc.request(
      "thread/start",
      { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" },
      signal,
    );
    const servers = [];
    let cursor;
    do {
      const page = await rpc.request(
        "mcpServerStatus/list",
        { threadId: thread.id, cursor, limit: 100 },
        signal,
      );
      servers.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const tools = readOnlySlackTools(servers);
    if (!tools.length)
      throw new Error(
        "Codex exposed no explicitly read-only Slack tools. Check that Slack works in Codex and the connector supplies readOnlyHint annotations.",
      );
    return await callback({ rpc, threadId: thread.id, tools });
  } finally {
    rpc?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function callSlack({ rpc, threadId, tools }, name, args, signal) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool)
    throw new Error(
      "Unknown or non-read-only Slack tool. List the available tools first.",
    );
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Slack arguments must be an object");
  return rpc.request(
    "mcpServer/tool/call",
    { threadId, server: tool.server, tool: tool.tool, arguments: args },
    signal,
  );
}
