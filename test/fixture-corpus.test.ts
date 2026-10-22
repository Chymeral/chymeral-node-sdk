import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ALL_CAPABILITIES,
  Client,
  CommandError,
  type Capability,
  type NodeHandle,
} from "../src/index.js";
import { FakeClpHost } from "./clp-host.js";

const FIXTURE_TOKEN = "fixture-token-not-a-secret";
const FIXTURE_V2_0_DIRECTORY = fileURLToPath(new URL("../fixtures/clp/v2.0/", import.meta.url));
const FIXTURE_V2_1_DIRECTORY = fileURLToPath(new URL("../fixtures/clp/v2.1/", import.meta.url));

type FixtureDirection = "client_to_host" | "host_to_client";
type FixtureKind = "json" | "binary";
type JsonObject = Record<string, unknown>;

interface FixtureFrame {
  readonly direction: FixtureDirection;
  readonly kind: FixtureKind;
  readonly message?: JsonObject;
  readonly bytes_hex?: string;
}

interface FixtureVector {
  readonly id: string;
  readonly frames: readonly FixtureFrame[];
}

interface FixtureCorpus {
  readonly format: string;
  readonly fixture_version: number;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly transport: {
    readonly maximum_frame_bytes: number;
    readonly json_discriminator: string;
    readonly binary_discriminator: string;
  };
  readonly vectors: readonly FixtureVector[];
}

class FixtureTranscript {
  private frameIndex = 0;
  private readonly requestIds = new Map<string, string>();

  public constructor(private readonly frames: readonly FixtureFrame[]) {}

  public async expectClientJson(host: FakeClpHost): Promise<void> {
    const expected = this.message(this.next("client_to_host", "json"));
    const actual = await host.nextJson();
    const expectedRequestId = requestId(expected);
    const actualRequestId = requestId(actual);

    if (expectedRequestId === undefined) {
      assert.equal(actualRequestId, undefined, "unexpected client request identifier");
    } else {
      assert.equal(expected.type, "command", "only commands may carry request identifiers");
      if (actualRequestId === undefined) {
        throw new Error("client command is missing its request identifier");
      }
      this.requestIds.set(expectedRequestId, actualRequestId);
      expected.request_id = actualRequestId;
    }

    assert.deepEqual(actual, expected);
  }

  public async expectClientBinary(host: FakeClpHost): Promise<void> {
    const frame = this.next("client_to_host", "binary");
    const actual = await host.nextFrame();
    assert.equal(actual.kind, "binary");
    assert.deepEqual(actual.payload, Buffer.from(this.bytes(frame), "hex"));
  }

  public async sendHostJson(host: FakeClpHost): Promise<void> {
    const message = this.message(this.next("host_to_client", "json"));
    const fixtureRequestId = requestId(message);
    if (fixtureRequestId !== undefined) {
      const clientRequestId = this.requestIds.get(fixtureRequestId);
      assert.notEqual(
        clientRequestId,
        undefined,
        `host response references unknown fixture request ${fixtureRequestId}`,
      );
      message.request_id = clientRequestId;
    }
    await host.sendJson(message);
  }

  public assertComplete(): void {
    assert.equal(this.frameIndex, this.frames.length, "fixture transcript was not fully replayed");
  }

  private next(direction: FixtureDirection, kind: FixtureKind): FixtureFrame {
    const frame = this.frames[this.frameIndex];
    if (frame === undefined) {
      throw new Error(`fixture ended before ${direction}/${kind} frame`);
    }
    this.frameIndex += 1;
    assert.equal(frame.direction, direction);
    assert.equal(frame.kind, kind);
    return frame;
  }

  private message(frame: FixtureFrame): JsonObject {
    if (frame.message === undefined) {
      throw new Error("fixture JSON frame is missing its message");
    }
    return cloneJson(frame.message);
  }

  private bytes(frame: FixtureFrame): string {
    if (frame.bytes_hex === undefined) {
      throw new Error("fixture binary frame is missing bytes_hex");
    }
    return frame.bytes_hex;
  }
}

test("replays the vendored canonical CLP v2.0 fixture corpus through the public client", async (context) => {
  const corpus = await loadFixtureCorpus(FIXTURE_V2_0_DIRECTORY, { major: 2, minor: 0 });
  await replayLifecycle(corpus, context);
  await replaySceneAndOverlap(corpus, context);
  await replayImages(corpus, context);
  await replayDeliveryErrorsAndFaultClose(corpus, context);
});

test("replays the vendored canonical CLP v2.1 fixture corpus through the public client", async (context) => {
  const corpus = await loadFixtureCorpus(FIXTURE_V2_1_DIRECTORY, { major: 2, minor: 1 });
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const transcript = new FixtureTranscript(vector(corpus, "frame-presentation").frames);
  const client = await connectV21FixtureClient(host, transcript);

  assert.deepEqual(client.session.protocolVersion, { major: 2, minor: 1 });
  assert.equal(client.hasCapability("presentation"), true);

  client.presentSceneWithId("fixture-presentation-1", [
    { node: "node-1" as NodeHandle, properties: { x: 96, y: 64 } },
    { node: "node-2" as NodeHandle, properties: { width: 48, height: 24 } },
  ]);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await client.nextNotification(), {
    kind: "presentation_status",
    presentation: {
      presentationId: "fixture-presentation-1",
      status: "presented",
    },
  });

  client.presentSceneWithId("fixture-presentation-2", [
    { node: "node-3" as NodeHandle, properties: { width: 88 } },
  ]);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await client.nextNotification(), {
    kind: "presentation_status",
    presentation: {
      presentationId: "fixture-presentation-2",
      status: "rejected",
      code: "invalid_node_change",
      message: "node-3 has intrinsic text bounds that cannot be set directly",
    },
  });

  const close = client.close();
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await close, { kind: "client_requested" });
  transcript.assertComplete();

  await replayWindowMetadata(corpus, context);
});

async function replayWindowMetadata(
  corpus: FixtureCorpus,
  context: test.TestContext,
): Promise<void> {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const transcript = new FixtureTranscript(vector(corpus, "application-window-metadata").frames);
  const client = await connectV21FixtureClient(host, transcript, ["images", "window_metadata"]);

  assert.equal(client.hasCapability("window_metadata"), true);
  assert.deepEqual(client.session.context.windowMetadata, { iconSupported: true });

  const imageUpload = client.uploadImage({
    kind: "rgba8",
    width: 1,
    height: 1,
    pixels: new Uint8Array([0xff, 0x7f, 0x00, 0xff]),
  });
  await transcript.expectClientJson(host);
  await transcript.expectClientBinary(host);
  await transcript.sendHostJson(host);
  const image = await imageUpload;

  const initial = client.setWindowMetadata({ title: "Fixture metadata", icon: image });
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await initial, { iconSupported: true });

  const titleOnly = client.setWindowMetadata({ title: "Refreshed fixture metadata" });
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await titleOnly, { iconSupported: true });

  const clear = client.setWindowMetadata({ title: null, icon: null });
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await clear, { iconSupported: true });

  const close = client.close();
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await close, { kind: "client_requested" });
  transcript.assertComplete();
}

async function replayLifecycle(corpus: FixtureCorpus, context: test.TestContext): Promise<void> {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const transcript = new FixtureTranscript(vector(corpus, "lifecycle-and-subscriptions").frames);
  const client = await connectFixtureClient(host, transcript);

  assert.deepEqual(client.session, {
    protocolVersion: { major: 2, minor: 0 },
    sessionId: "session-1",
    capabilities: new Set([
      "scene",
      "images",
      "input",
      "timing",
      "overlap",
      "external_drop",
      "text",
    ]),
    context: {
      arguments: ["--fixture"],
      initialCommands: [{ name: "open", arguments: ["fixture"] }],
    },
  });

  const subscriptions = client.subscribe(["raw_input", "terminal", "timing"]);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await subscriptions, ["raw_input", "terminal", "timing"]);

  await transcript.sendHostJson(host);
  await transcript.sendHostJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await client.nextNotification(), {
    kind: "resize",
    resize: {
      physicalWidth: 1600,
      physicalHeight: 900,
      logicalWidth: 800,
      logicalHeight: 450,
      scaleFactor: 2,
    },
  });
  assert.deepEqual(await client.nextNotification(), { kind: "tick", dtNs: 16_666_667n });
  assert.deepEqual(await client.nextNotification(), { kind: "frame", dtNs: 16_666_667n });

  const close = client.close();
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await close, { kind: "client_requested" });
  transcript.assertComplete();
}

async function replaySceneAndOverlap(
  corpus: FixtureCorpus,
  context: test.TestContext,
): Promise<void> {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const transcript = new FixtureTranscript(runningSessionFrames(corpus, "scene-text-and-overlap"));
  const client = await connectFixtureClient(host, transcript);

  const rectanglePromise = client.createNode(
    {
      kind: "rectangle",
      properties: {
        x: 24,
        y: 32,
        width: 160,
        height: 72,
        visible: true,
        clipChildren: false,
        zIndex: 2,
        overlapEnabled: true,
        externalDropEnabled: false,
        inputPassthrough: false,
      },
      color: [37, 99, 235, 230],
    },
    { layer: "overlay" },
  );
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  const rectangle = await rectanglePromise;
  assert.deepEqual(await rectangle, { node: "node-1" });

  const textPromise = client.createNode(
    {
      kind: "text",
      properties: {
        x: 48,
        y: 56,
        visible: true,
        clipChildren: false,
        zIndex: 3,
        overlapEnabled: true,
        externalDropEnabled: false,
        inputPassthrough: false,
      },
      text: "Status:\tready\n界",
      style: { weight: "bold", align: "start", color: [220, 230, 255, 255] },
    },
    { layer: "overlay" },
  );
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  const text = await textPromise;
  assert.deepEqual(text, {
    node: "node-2",
    textMetrics: { columns: 13, rows: 2, width: 104, height: 36 },
  });

  await transcript.sendHostJson(host);
  assert.deepEqual(await client.nextNotification(), {
    kind: "event",
    event: {
      kind: "scene",
      event: { kind: "overlap_enter", first: "node-1", second: "node-2" },
    },
  });

  const update = client.setNode(rectangleNode(rectangle), {
    properties: { x: 64, inputPassthrough: true },
  });
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.equal(await update, undefined);

  const overlapping = client.isOverlapping(rectangleNode(rectangle));
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.equal(await overlapping, true);

  const overlaps = client.getOverlaps(rectangleNode(rectangle));
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await overlaps, ["node-2"]);

  const removeText = client.removeNode(text.node);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await removeText;

  const removeRectangle = client.removeNode(rectangleNode(rectangle));
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await removeRectangle;
  transcript.assertComplete();
}

async function replayImages(corpus: FixtureCorpus, context: test.TestContext): Promise<void> {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const transcript = new FixtureTranscript(
    runningSessionFrames(corpus, "image-upload-and-cleanup"),
  );
  const client = await connectFixtureClient(host, transcript);

  const rgba8 = client.uploadImage({
    kind: "rgba8",
    width: 1,
    height: 1,
    pixels: Buffer.from("ff8000ff", "hex"),
  });
  await transcript.expectClientJson(host);
  await transcript.expectClientBinary(host);
  await transcript.sendHostJson(host);
  const image = await rgba8;
  assert.equal(image, "image-1");

  const imageNode = client.createNode(
    {
      kind: "image",
      properties: {
        x: 96,
        y: 64,
        width: 48,
        height: 48,
        visible: true,
        clipChildren: false,
        zIndex: 1,
        overlapEnabled: true,
        externalDropEnabled: true,
        inputPassthrough: false,
      },
      image,
      opacity: 0.75,
      contactShape: { kind: "alpha", threshold: 1 },
    },
    { layer: "overlay" },
  );
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await imageNode, { node: "node-3" });

  const removeNode = client.removeNode("node-3" as NodeHandle);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await removeNode;

  const removeRgba8 = client.removeImage(image);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await removeRgba8;

  const gif = client.uploadImage({
    kind: "gif",
    bytes: Buffer.from(
      "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024c01003b",
      "hex",
    ),
  });
  await transcript.expectClientJson(host);
  await transcript.expectClientBinary(host);
  await transcript.sendHostJson(host);
  const gifImage = await gif;
  assert.equal(gifImage, "image-2");

  const removeGif = client.removeImage(gifImage);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await removeGif;
  transcript.assertComplete();
}

async function replayDeliveryErrorsAndFaultClose(
  corpus: FixtureCorpus,
  context: test.TestContext,
): Promise<void> {
  const host = await FakeClpHost.start();
  context.after(() => host.close());
  const transcript = new FixtureTranscript(
    runningSessionFrames(corpus, "delivery-errors-and-fault-close"),
  );
  const client = await connectFixtureClient(host, transcript);

  await transcript.sendHostJson(host);
  await transcript.sendHostJson(host);
  const rejected = client.isOverlapping("node-99" as NodeHandle);
  const rejectedAssertion = assert.rejects(
    rejected,
    (error: unknown) =>
      error instanceof CommandError &&
      error.code === "not_owner" &&
      error.message.endsWith(": node-99 is not owned by this session"),
  );
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await rejectedAssertion;

  assert.deepEqual(await client.nextNotification(), {
    kind: "event",
    event: {
      kind: "scene",
      event: {
        kind: "external_drop",
        target: "node-5",
        position: { x: 120, y: 80 },
        files: [{ uri: "file:///tmp/fixture.txt" }],
      },
    },
  });
  assert.deepEqual(await client.nextNotification(), {
    kind: "delivery_gap",
    categories: ["scene", "timing"],
  });

  const fault = client.reportFault("event", "fixture program fault");
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  assert.deepEqual(await fault, {
    kind: "program_fault",
    phase: "event",
    message: "fixture program fault",
  });
  transcript.assertComplete();
}

async function connectFixtureClient(
  host: FakeClpHost,
  transcript: FixtureTranscript,
): Promise<Client> {
  const connecting = Client.connect(host.endpoint, FIXTURE_TOKEN);
  assert.deepEqual(await host.nextJson(), {
    type: "hello",
    protocol: { major: 2, minor: 1 },
    token: FIXTURE_TOKEN,
    capabilities: [...ALL_CAPABILITIES],
  });
  await host.sendJson({
    type: "error",
    code: "unsupported_version",
    message: "fixture CLP v2.0 host",
  });
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await transcript.expectClientJson(host);
  return connecting;
}

async function connectV21FixtureClient(
  host: FakeClpHost,
  transcript: FixtureTranscript,
  capabilities: Iterable<Capability> = ALL_CAPABILITIES,
): Promise<Client> {
  const connecting = Client.connect(host.endpoint, FIXTURE_TOKEN, capabilities);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await transcript.expectClientJson(host);
  await transcript.sendHostJson(host);
  await transcript.expectClientJson(host);
  return connecting;
}

async function loadFixtureCorpus(
  directory: string,
  protocol: FixtureCorpus["protocol"],
): Promise<FixtureCorpus> {
  const [fixtureBytes, checksumBytes] = await Promise.all([
    readFile(`${directory}fixtures.json`),
    readFile(`${directory}SHA256SUMS`),
  ]);
  const expectedHash = checksumBytes.toString("utf8").trim().split(/\s+/)[0];
  if (expectedHash === undefined || expectedHash.length === 0) {
    throw new Error("fixture SHA256SUMS does not contain a checksum");
  }
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), expectedHash);

  const corpus = JSON.parse(fixtureBytes.toString("utf8")) as FixtureCorpus;
  assert.equal(corpus.format, "chymeral-clp-fixture-corpus");
  assert.equal(corpus.fixture_version, 1);
  assert.deepEqual(corpus.protocol, protocol);
  assert.equal(corpus.transport.maximum_frame_bytes, 1024 * 1024);
  assert.equal(corpus.transport.json_discriminator, "J");
  assert.equal(corpus.transport.binary_discriminator, "B");
  return corpus;
}

function runningSessionFrames(corpus: FixtureCorpus, vectorId: string): readonly FixtureFrame[] {
  return [
    ...vector(corpus, "lifecycle-and-subscriptions").frames.slice(0, 5),
    ...vector(corpus, vectorId).frames,
  ];
}

function vector(corpus: FixtureCorpus, id: string): FixtureVector {
  const found = corpus.vectors.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`fixture corpus does not contain vector ${id}`);
  }
  return found;
}

function requestId(message: JsonObject): string | undefined {
  const value = message.request_id;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("fixture request_id must be a string");
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rectangleNode(node: { readonly node: NodeHandle }): NodeHandle {
  return node.node;
}
