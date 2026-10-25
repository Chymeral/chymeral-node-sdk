import { Client, SceneBatch, type NodeHandle, type Notification } from "../src/index.js";

const PANEL_X = 80;
const PANEL_Y = 88;
const PANEL_WIDTH = 548;
const PANEL_HEIGHT = 256;

interface ProbeNodes {
  readonly panel: NodeHandle;
  readonly status: NodeHandle;
}

async function main(): Promise<void> {
  let client: Client | undefined;
  let nodes: ProbeNodes | undefined;

  try {
    client = await Client.connectFromEnv(["input", "scene", "scene_batch", "text"]);
    if (!client.hasCapability("scene_batch")) {
      throw new Error("the connected host did not grant scene_batch (introduced by CLP v2.4)");
    }
    await client.subscribe(["raw_input"]);
    console.log("Submitting the 13-operation atomic scene batch.");
    nodes = await createProbeNodes(client);
    console.log("The atomic scene batch was acknowledged by the host.");

    console.log(
      `CLP v${client.session.protocolVersion.major}.${client.session.protocolVersion.minor} scene-batch probe connected.`,
    );
    console.log(
      "The complete panel was created by one atomic retained-scene command. Click anywhere inside it to confirm scene input and focus this session, then press q to close only this session.",
    );

    let inputConfirmed = false;
    for (;;) {
      const notification = await client.nextNotification();
      if (!inputConfirmed && isPointerPress(notification)) {
        inputConfirmed = true;
        console.log("Pointer press reached the CLP session; applying visual acknowledgement.");
        await client.setNode(nodes.status, {
          text: "Pointer received; keyboard focus is active. Press q to close.",
          textStyle: { color: [134, 239, 172, 255], weight: "bold" },
        });
        console.log("Pointer input confirmed; this session now owns keyboard input.");
      }
      if (shouldClose(notification)) {
        console.log("q reached the CLP session; closing only this session.");
        break;
      }
    }
  } finally {
    if (client !== undefined && nodes !== undefined) {
      await client.removeNode(nodes.panel).catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
  }
}

async function createProbeNodes(client: Client): Promise<ProbeNodes> {
  const batch = new SceneBatch()
    .createNode(
      "panel",
      {
        kind: "empty",
        properties: {
          x: PANEL_X - 24,
          y: PANEL_Y,
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
          clipChildren: true,
        },
      },
      { layer: "overlay" },
    )
    .createNode(
      "backdrop",
      {
        kind: "rectangle",
        properties: { x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT },
        color: [15, 23, 42, 238],
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "header",
      {
        kind: "rectangle",
        properties: { x: 0, y: 0, width: PANEL_WIDTH, height: 54 },
        color: [37, 99, 235, 255],
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "title",
      {
        kind: "text",
        properties: { x: 20, y: 13 },
        text: "CLP v2.4 atomic scene batch",
        style: { color: [255, 255, 255, 255], size: 18, weight: "bold" },
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "description",
      {
        kind: "text",
        properties: { x: 20, y: 72 },
        text: "One retained-scene transition for a complete first paint.\nNo visible node-by-node assembly.",
        style: { color: [203, 213, 225, 255], size: 14 },
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "tree-card",
      {
        kind: "rectangle",
        properties: { x: 20, y: 138, width: 154, height: 84 },
        color: [30, 58, 138, 255],
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "tree-label",
      {
        kind: "text",
        properties: { x: 12, y: 12 },
        text: "TREE\nparent before child",
        style: { color: [255, 255, 255, 255], size: 13, weight: "bold" },
      },
      { parent: SceneBatch.alias("tree-card") },
    )
    .createNode(
      "result-card",
      {
        kind: "rectangle",
        properties: { x: 197, y: 138, width: 154, height: 84 },
        color: [8, 145, 178, 255],
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "result-label",
      {
        kind: "text",
        properties: { x: 12, y: 12 },
        text: "RESULT\nsurviving handles",
        style: { color: [255, 255, 255, 255], size: 13, weight: "bold" },
      },
      { parent: SceneBatch.alias("result-card") },
    )
    .createNode(
      "rollback-card",
      {
        kind: "rectangle",
        properties: { x: 374, y: 138, width: 154, height: 84 },
        color: [154, 52, 18, 255],
      },
      { parent: SceneBatch.alias("panel") },
    )
    .createNode(
      "rollback-label",
      {
        kind: "text",
        properties: { x: 12, y: 12 },
        text: "ROLLBACK\nall or nothing",
        style: { color: [255, 255, 255, 255], size: 13, weight: "bold" },
      },
      { parent: SceneBatch.alias("rollback-card") },
    )
    .createNode(
      "status",
      {
        kind: "text",
        properties: { x: 20, y: 234 },
        text: "Click anywhere inside this panel to confirm pointer input; then press q to close.",
        style: { color: [147, 197, 253, 255], size: 12 },
      },
      { parent: SceneBatch.alias("panel") },
    )
    .setNode(SceneBatch.alias("panel"), { properties: { x: PANEL_X } });
  const result = await client.applySceneBatch(batch);
  const panel = result.nodes.panel;
  if (
    panel === undefined ||
    result.nodes.title === undefined ||
    result.nodes["tree-label"] === undefined ||
    result.nodes["result-label"] === undefined ||
    result.nodes["rollback-label"] === undefined ||
    result.nodes.status === undefined ||
    result.operations.length !== 13
  ) {
    throw new Error("scene-batch probe did not receive its complete retained tree");
  }
  return { panel: panel.node, status: result.nodes.status.node };
}

function isPointerPress(notification: Notification): boolean {
  if (notification.kind !== "event") {
    return false;
  }
  if (notification.event.kind === "pointer_press") {
    return true;
  }
  return notification.event.kind === "scene" && notification.event.event.kind === "pointer_press";
}

function shouldClose(notification: Notification): boolean {
  if (
    notification.kind === "event" &&
    notification.event.kind === "key" &&
    notification.event.state === "pressed" &&
    notification.event.key.kind === "character" &&
    notification.event.key.value.toLowerCase() === "q"
  ) {
    return true;
  }
  if (notification.kind === "closing" || notification.kind === "closed") {
    throw new Error(`session closed: ${notification.reason.kind}`);
  }
  return false;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
