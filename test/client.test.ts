import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_CAPABILITIES,
  BINARY_FRAGMENT_BYTES,
  CapabilityNotGrantedError,
  Client,
  CommandError,
  InvalidInputError,
  ProtocolError,
  type Capability,
  type NodeHandle,
} from "../src/index.js";
import { FakeClpHost } from "./clp-host.js";

const SESSION_ID = "session-1";

test("completes CLP v2.0 lifecycle and serializes the complete public API", async (context) => {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const client = await connectClient(host);

  assert.equal(client.session.sessionId, SESSION_ID);
  assert.deepEqual([...client.session.capabilities], [...ALL_CAPABILITIES]);
  assert.deepEqual(client.session.context, {
    arguments: ["--from-test"],
    initialCommands: [{ name: "open", arguments: ["sample"] }],
  });
  (client.session.capabilities as Set<Capability>).clear();
  (client.session.context.arguments as string[]).push("mutated");
  assert.equal(client.hasCapability("scene"), true);
  assert.deepEqual([...client.session.capabilities], [...ALL_CAPABILITIES]);
  assert.deepEqual(client.session.context.arguments, ["--from-test"]);

  const subscribe = client.subscribe(["timing", "raw_input"]);
  assert.deepEqual(await host.nextJson(), {
    type: "subscribe",
    subscriptions: ["raw_input", "timing"],
  });
  await host.sendJson({
    type: "subscribed",
    session_id: SESSION_ID,
    subscriptions: ["raw_input", "timing"],
  });
  assert.deepEqual(await subscribe, ["raw_input", "timing"]);

  const pixels = new Uint8Array(129 * 128 * 4);
  pixels.fill(0xa5);
  const upload = client.uploadImage({ kind: "rgba8", width: 129, height: 128, pixels });
  const uploadEnvelope = await nextCommand(host, {
    op: "upload_image",
    source: { kind: "rgba8", width: 129, height: 128 },
  });
  const firstFragment = await host.nextFrame();
  const secondFragment = await host.nextFrame();
  assert.equal(firstFragment.kind, "binary");
  assert.equal(firstFragment.payload.byteLength, BINARY_FRAGMENT_BYTES);
  assert.equal(secondFragment.kind, "binary");
  assert.equal(secondFragment.payload.byteLength, pixels.byteLength - BINARY_FRAGMENT_BYTES);
  assert.deepEqual(
    Buffer.concat([firstFragment.payload, secondFragment.payload]),
    Buffer.from(pixels),
  );
  await host.sendJson({
    type: "result",
    request_id: uploadEnvelope.requestId,
    result: { kind: "image", image: "image-1" },
  });
  const image = await upload;
  assert.equal(image, "image-1");

  const createImage = client.createNode(
    {
      kind: "image",
      properties: {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        clipChildren: true,
        zIndex: 3,
        overlapEnabled: true,
        externalDropEnabled: true,
        inputPassthrough: true,
      },
      image,
      opacity: 0.5,
      contactShape: { kind: "alpha", threshold: 1 },
    },
    { layer: "underlay" },
  );
  const createImageEnvelope = await nextCommand(host, {
    op: "create_node",
    layer: "underlay",
    node: {
      kind: "image",
      properties: {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        visible: true,
        clip_children: true,
        z_index: 3,
        overlap_enabled: true,
        external_drop_enabled: true,
        input_passthrough: true,
      },
      image: "image-1",
      opacity: 0.5,
      contact_shape: { kind: "alpha", threshold: 1 },
    },
  });
  await host.sendJson({
    type: "event",
    session_id: SESSION_ID,
    event: {
      kind: "scene",
      event: {
        kind: "external_drop",
        target: "node-1",
        position: { x: 11, y: 21 },
        files: [{ uri: "file:///tmp/one.txt" }],
      },
    },
  });
  await host.sendJson({
    type: "result",
    request_id: createImageEnvelope.requestId,
    result: { kind: "node", node: "node-1" },
  });
  const imageNode = (await createImage).node;
  assert.equal(imageNode, "node-1");

  assert.deepEqual(await client.nextNotification(), {
    kind: "event",
    event: {
      kind: "scene",
      event: {
        kind: "external_drop",
        target: "node-1",
        position: { x: 11, y: 21 },
        files: [{ uri: "file:///tmp/one.txt" }],
      },
    },
  });

  const createText = client.createNode({
    kind: "text",
    properties: { x: 2, y: 4, zIndex: 5 },
    text: "a\tb\n界",
    style: {
      font: "Chymeral Mono",
      size: 15,
      lineHeight: 18,
      color: [1, 2, 3, 4],
      weight: "bold",
      align: "center",
    },
  });
  const createTextEnvelope = await nextCommand(host, {
    op: "create_node",
    node: {
      kind: "text",
      properties: {
        x: 2,
        y: 4,
        visible: true,
        clip_children: false,
        z_index: 5,
        overlap_enabled: false,
        external_drop_enabled: false,
        input_passthrough: false,
      },
      text: "a\tb\n界",
      style: {
        font: "Chymeral Mono",
        size: 15,
        line_height: 18,
        color: [1, 2, 3, 4],
        weight: "bold",
        align: "center",
      },
    },
  });
  await host.sendJson({
    type: "result",
    request_id: createTextEnvelope.requestId,
    result: {
      kind: "node",
      node: "node-2",
      text_metrics: { columns: 9, rows: 2, width: 90, height: 36 },
    },
  });
  assert.deepEqual(await createText, {
    node: "node-2",
    textMetrics: { columns: 9, rows: 2, width: 90, height: 36 },
  });

  const updateText = client.setNode("node-2" as NodeHandle, {
    text: "updated\n",
    textStyle: { weight: "normal", align: "end" },
  });
  const updateEnvelope = await nextCommand(host, {
    op: "set_node",
    node: "node-2",
    changes: {
      text: "updated\n",
      text_style: { weight: "normal", align: "end" },
    },
  });
  await host.sendJson({
    type: "result",
    request_id: updateEnvelope.requestId,
    result: {
      kind: "node_updated",
      text_metrics: { columns: 7, rows: 2, width: 70, height: 36 },
    },
  });
  assert.deepEqual(await updateText, { columns: 7, rows: 2, width: 70, height: 36 });

  const overlap = client.isOverlapping(imageNode);
  const overlapEnvelope = await nextCommand(host, { op: "is_overlapping", node: "node-1" });
  await host.sendJson({
    type: "result",
    request_id: overlapEnvelope.requestId,
    result: { kind: "is_overlapping", overlapping: true },
  });
  assert.equal(await overlap, true);

  const overlaps = client.getOverlaps(imageNode);
  const overlapsEnvelope = await nextCommand(host, { op: "get_overlaps", node: "node-1" });
  await host.sendJson({
    type: "result",
    request_id: overlapsEnvelope.requestId,
    result: { kind: "overlaps", nodes: ["node-2"] },
  });
  assert.deepEqual(await overlaps, ["node-2"]);

  const removeNode = client.removeNode("node-2" as NodeHandle);
  const removeNodeEnvelope = await nextCommand(host, { op: "remove_node", node: "node-2" });
  await sendAcknowledged(host, removeNodeEnvelope.requestId);
  await removeNode;

  const removeImage = client.removeImage(image);
  const removeImageEnvelope = await nextCommand(host, { op: "remove_image", image: "image-1" });
  await sendAcknowledged(host, removeImageEnvelope.requestId);
  await removeImage;

  const close = client.close();
  assert.deepEqual(await host.nextJson(), { type: "close" });
  const reason = { kind: "client_requested" } as const;
  await host.sendJson({ type: "closing", session_id: SESSION_ID, reason });
  await host.sendJson({ type: "closed", session_id: SESSION_ID, reason });
  assert.deepEqual(await close, reason);
  assert.deepEqual(await client.nextNotification(), { kind: "closing", reason });
  assert.deepEqual(await client.nextNotification(), { kind: "closed", reason });
});

test("rejects unsupported local operations before they reach the host", async (context) => {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const client = await connectClient(host, ["scene"]);

  await assert.rejects(
    client.uploadImage({ kind: "gif", bytes: new Uint8Array() }),
    CapabilityNotGrantedError,
  );
  await assert.rejects(
    client.createNode({
      kind: "rectangle",
      properties: { x: 0, y: 0, width: 1, height: 1, overlapEnabled: true },
      color: [0, 0, 0, 255],
    }),
    CapabilityNotGrantedError,
  );
  await assert.rejects(
    client.createNode({
      kind: "rectangle",
      properties: { x: 0, y: 0, width: 1, height: 1 },
      color: [0, 0, 0, 999],
    }),
    InvalidInputError,
  );

  const close = client.close();
  assert.deepEqual(await host.nextJson(), { type: "close" });
  const reason = { kind: "client_requested" } as const;
  await host.sendJson({ type: "closed", session_id: SESSION_ID, reason });
  assert.deepEqual(await close, reason);
});

test("surfaces command errors and reports a session-scoped program fault", async (context) => {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const client = await connectClient(host);

  const overlap = client.isOverlapping("node-1" as NodeHandle);
  const overlapEnvelope = await nextCommand(host, { op: "is_overlapping", node: "node-1" });
  const rejectedOverlap = assert.rejects(
    overlap,
    (error: unknown) =>
      error instanceof CommandError &&
      error.requestId === overlapEnvelope.requestId &&
      error.code === "unknown_node",
  );
  await host.sendJson({
    type: "command_error",
    request_id: overlapEnvelope.requestId,
    code: "unknown_node",
    message: "node-1 is not owned by this session",
  });
  await rejectedOverlap;

  const fault = client.reportFault("event", "intentional conformance fault");
  assert.deepEqual(await host.nextJson(), {
    type: "fault",
    phase: "event",
    message: "intentional conformance fault",
  });
  const reason = {
    kind: "program_fault",
    phase: "event",
    message: "intentional conformance fault",
  } as const;
  await host.sendJson({ type: "closed", session_id: SESSION_ID, reason });
  assert.deepEqual(await fault, reason);
});

test("fails explicitly when the host violates response ordering", async (context) => {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const client = await connectClient(host);

  await host.sendJson({
    type: "result",
    request_id: "node-sdk-99",
    result: { kind: "acknowledged" },
  });
  await assert.rejects(client.nextNotification(), ProtocolError);
});

test("decodes fragmented host frames and ends notification iteration at closed", async (context) => {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const client = await connectClient(host, ALL_CAPABILITIES, true);

  const notifications = client.notifications();
  const first = notifications.next();
  await host.sendJsonFragmented({ type: "tick", session_id: SESSION_ID, dt_ns: "16666667" }, 3);
  assert.deepEqual(await first, { done: false, value: { kind: "tick", dtNs: 16_666_667n } });

  const close = client.close();
  assert.deepEqual(await host.nextJson(), { type: "close" });
  const reason = { kind: "host_shutdown" } as const;
  await host.sendJsonFragmented({ type: "closed", session_id: SESSION_ID, reason }, 2);
  assert.deepEqual(await close, reason);
  assert.deepEqual(await notifications.next(), { done: false, value: { kind: "closed", reason } });
  assert.deepEqual(await notifications.next(), { done: true, value: undefined });
});

async function connectClient(
  host: FakeClpHost,
  capabilities: Iterable<Capability> = ALL_CAPABILITIES,
  fragmentInit = false,
): Promise<Client> {
  const connecting = Client.connect(host.endpoint, "test-token", capabilities);
  assert.deepEqual(await host.nextJson(), {
    type: "hello",
    protocol: { major: 2, minor: 0 },
    token: "test-token",
    capabilities: [...capabilities],
  });
  const init = {
    type: "init",
    protocol: { major: 2, minor: 0 },
    session_id: SESSION_ID,
    capabilities: [...capabilities],
    context: {
      arguments: ["--from-test"],
      initial_commands: [{ name: "open", arguments: ["sample"] }],
    },
  };
  if (fragmentInit) {
    await host.sendJsonFragmented(init, 5);
  } else {
    await host.sendJson(init);
  }
  assert.deepEqual(await host.nextJson(), { type: "init_complete" });
  await host.sendJson({ type: "start", session_id: SESSION_ID });
  assert.deepEqual(await host.nextJson(), { type: "started" });
  return connecting;
}

async function nextCommand(
  host: FakeClpHost,
  command: Record<string, unknown>,
): Promise<{ readonly requestId: string }> {
  const envelope = await host.nextJson();
  assert.equal(envelope.type, "command");
  assert.equal(typeof envelope.request_id, "string");
  assert.deepEqual(envelope.command, command);
  return { requestId: envelope.request_id as string };
}

async function sendAcknowledged(host: FakeClpHost, requestId: string): Promise<void> {
  await host.sendJson({
    type: "result",
    request_id: requestId,
    result: { kind: "acknowledged" },
  });
}
