import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callSlack,
  CodexRpc,
  readOnlySlackTools,
  withSlack,
} from "./codex.mjs";

const readOnly = {
  annotations: { readOnlyHint: true },
  inputSchema: { type: "object" },
};
const servers = [
  {
    name: "codex_apps",
    tools: {
      slack_search: readOnly,
      slack_post: { annotations: { readOnlyHint: false } },
      slack_unknown: {},
      slack_conflicting: {
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
      github_search: {
        ...readOnly,
        _meta: { description: "Search links from Slack" },
      },
      notslack_search: readOnly,
    },
  },
];

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.emit("close");
    return true;
  };
  return child;
}

function reply(child, message) {
  child.stdout.write(JSON.stringify(message) + "\n");
}

test("only explicitly read-only Slack tools are exposed", () => {
  assert.deepEqual(
    readOnlySlackTools(servers).map((tool) => tool.name),
    ["codex_apps/slack_search"],
  );
  assert.equal(
    readOnlySlackTools([{ name: "slack", tools: { search: readOnly } }]).length,
    1,
  );
});

test("hosted Slack connector metadata identifies opaque tool names", () => {
  assert.equal(
    readOnlySlackTools([
      {
        name: "codex_apps",
        tools: {
          opaque_search: { ...readOnly, _meta: { connector_name: "Slack" } },
        },
      },
    ]).length,
    1,
  );
});

test("tool schemas are preserved", () => {
  assert.deepEqual(readOnlySlackTools(servers)[0].inputSchema, {
    type: "object",
  });
});

test("calls only a tool in the validated inventory", async () => {
  const calls = [];
  const bridge = {
    threadId: "test-thread",
    tools: readOnlySlackTools(servers),
    rpc: {
      request: (...args) => {
        calls.push(args);
        return { content: [] };
      },
    },
  };
  await callSlack(bridge, "codex_apps/slack_search", {
    query: "in:team-rocket",
  });
  assert.equal(calls[0][0], "mcpServer/tool/call");
  assert.deepEqual(calls[0][1], {
    threadId: "test-thread",
    server: "codex_apps",
    tool: "slack_search",
    arguments: { query: "in:team-rocket" },
  });
  await assert.rejects(
    callSlack(bridge, "codex_apps/slack_post", {}),
    /non-read-only/,
  );
  await assert.rejects(
    callSlack(bridge, "codex_apps/slack_search", []),
    /must be an object/,
  );
  assert.equal(calls.length, 1);
});

test("RPC matches concurrent responses by id and ignores notifications", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  try {
    const first = rpc.request("first", {});
    const second = rpc.request("second", {});
    reply(child, { method: "notice", params: {} });
    reply(child, { id: 2, result: { second: true } });
    reply(child, { id: 1, result: { first: true } });
    assert.deepEqual(await first, { first: true });
    assert.deepEqual(await second, { second: true });
    assert.equal(rpc.pending.size, 0);
  } finally {
    rpc.close();
  }
});

test("RPC errors fail the call", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  const result = rpc.request("broken", {});
  reply(child, {
    id: 1,
    error: { code: -32601, message: "Unsupported method" },
  });
  await assert.rejects(result, /Unsupported method/);
  rpc.close();
});

test("RPC rejects authentication and approval requests without accepting them", () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  let sent = "";
  child.stdin.on("data", (chunk) => {
    sent += chunk;
  });
  reply(child, { id: "approval", method: "item/tool/requestUserInput" });
  assert.equal(JSON.parse(sent).error.code, -32601);
  rpc.close();
});

test("cancellation terminates Codex and rejects pending requests", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  const controller = new AbortController();
  const result = rpc.request("slow", {}, controller.signal);
  controller.abort();
  await assert.rejects(result, /cancelled/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(rpc.pending.size, 0);
});

test("already cancelled requests are never sent", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(rpc.request("slow", {}, controller.signal), /cancelled/);
  assert.equal(child.stdin.readableLength, 0);
  rpc.close();
});

test("timeout terminates Codex", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child, 10);
  await assert.rejects(rpc.request("slow", {}), /timed out/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("process failure rejects pending calls without forwarding diagnostics", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  const result = rpc.request("slow", {});
  child.stderr.write("private diagnostics");
  child.emit("exit", 1);
  await assert.rejects(result, /Codex app-server exited/);
  assert.equal(rpc.pending.size, 0);
});

test("invalid protocol data fails closed", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  const result = rpc.request("slow", {});
  child.stdout.write("not json\n");
  await assert.rejects(result, /Invalid JSON/);
});

test("full bridge starts an ephemeral thread and returns original MCP results without a model call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slack-test-"));
  const originalPath = process.env.PATH;
  try {
    const executable = join(directory, "codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize': result = {}; break;
    case 'thread/start':
      if (!request.params.ephemeral || request.params.sandbox !== 'read-only') process.exit(1);
      result = {thread:{id:'fixture-thread'}}; break;
    case 'mcpServerStatus/list':
      result = {data:[{name:'slack', tools:{search:{annotations:{readOnlyHint:true},inputSchema:{type:'object'}}}}],nextCursor:null}; break;
    case 'mcpServer/tool/call':
      result = {content:[{type:'text',text:'Original Slack message'}],isError:false}; break;
    default: process.exit(1);
  }
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
    );
    await chmod(executable, 0o700);
    process.env.PATH = `${directory}:${originalPath}`;
    const result = await withSlack(async (bridge) => {
      assert.equal(bridge.tools[0].name, "slack/search");
      return callSlack(bridge, "slack/search", { query: "test" });
    });
    assert.equal(result.content[0].text, "Original Slack message");
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing executable gives actionable error", async () => {
  const child = fakeChild();
  const rpc = new CodexRpc(child);
  const result = rpc.request("initialize", {});
  child.emit("error", new Error("ENOENT"));
  await assert.rejects(result, /Install Codex CLI/);
});
