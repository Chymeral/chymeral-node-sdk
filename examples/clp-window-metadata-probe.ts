import { Client, type ImageHandle, type NodeHandle, type Notification } from "../src/index.js";

const ICON_SIZE = 32;

interface ProbeNodes {
  readonly panel: NodeHandle;
  readonly label: NodeHandle;
}

async function main(): Promise<void> {
  let client: Client | undefined;
  let nodes: ProbeNodes | undefined;
  let icon: ImageHandle | undefined;
  let metadataActive = false;
  let alternateTitle = false;

  try {
    client = await Client.connectFromEnv(["images", "input", "scene", "text", "window_metadata"]);
    if (!client.hasCapability("window_metadata")) {
      throw new Error("the connected host did not grant CLP v2.1 window_metadata");
    }
    await client.subscribe(["raw_input"]);
    nodes = await createProbeNodes(client);
    const uploadedIcon = await client.uploadImage({
      kind: "rgba8",
      width: ICON_SIZE,
      height: ICON_SIZE,
      pixels: iconPixels(),
    });
    icon = uploadedIcon;

    const status = await client.setWindowMetadata({
      title: "Chymeral window metadata probe",
      icon: uploadedIcon,
    });
    const expectedIconSupport = client.session.context.windowMetadata?.iconSupported;
    if (expectedIconSupport !== undefined && status.iconSupported !== expectedIconSupport) {
      throw new Error("window metadata support disagreed with its command result");
    }
    metadataActive = true;

    console.log(
      "CLP v2.1 window metadata probe connected. The native window title is now owned by this session.",
    );
    console.log(
      `Dynamic icon support on this backend: ${status.iconSupported}. Click the blue panel to focus this session.`,
    );
    console.log(
      "Press t to replace only the title, c to clear title and icon, r to restore both, or q to close only this session.",
    );

    for (;;) {
      const key = pressedCharacter(await client.nextNotification());
      if (key === undefined) {
        continue;
      }
      if (key === "q") {
        break;
      }
      if (key === "t") {
        if (!metadataActive) {
          console.log("Metadata is cleared. Press r to restore the title and icon together.");
          continue;
        }
        alternateTitle = !alternateTitle;
        const title = alternateTitle
          ? "Chymeral window metadata probe — refreshed"
          : "Chymeral window metadata probe";
        await client.setWindowMetadata({ title });
        console.log(`Title-only update applied: ${title}`);
        continue;
      }
      if (key === "c") {
        await client.setWindowMetadata({ title: null, icon: null });
        metadataActive = false;
        console.log("Metadata cleared; the terminal-derived title and bundled icon are restored.");
        continue;
      }
      if (key === "r") {
        if (icon === undefined) {
          throw new Error("the probe icon was unexpectedly unavailable");
        }
        const status = await client.setWindowMetadata({
          title: "Chymeral window metadata probe",
          icon,
        });
        metadataActive = true;
        alternateTitle = false;
        console.log(`Title and icon restored. Dynamic icon support: ${status.iconSupported}.`);
      }
    }
  } finally {
    if (client !== undefined && metadataActive) {
      await client.setWindowMetadata({ title: null, icon: null }).catch(() => undefined);
    }
    if (client !== undefined && nodes !== undefined) {
      await client.removeNode(nodes.label).catch(() => undefined);
      await client.removeNode(nodes.panel).catch(() => undefined);
    }
    if (client !== undefined && icon !== undefined) {
      await client.removeImage(icon).catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
  }
}

async function createProbeNodes(client: Client): Promise<ProbeNodes> {
  const panel = await client.createNode(
    {
      kind: "rectangle",
      properties: { x: 48, y: 48, width: 460, height: 110 },
      color: [37, 99, 235, 230],
    },
    { layer: "overlay" },
  );
  const label = await client.createNode(
    {
      kind: "text",
      properties: { x: 16, y: 16 },
      text: "CLP v2.1 window metadata probe\nclick here, then t / c / r / q",
      style: { color: [255, 255, 255, 255], weight: "bold" },
    },
    { parent: panel.node },
  );
  return { panel: panel.node, label: label.node };
}

function iconPixels(): Uint8Array {
  const pixels = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const offset = (y * ICON_SIZE + x) * 4;
      const border = x < 4 || y < 4 || x >= ICON_SIZE - 4 || y >= ICON_SIZE - 4;
      const accent = (x + y) % 8 < 4;
      pixels.set(
        border ? [249, 115, 22, 255] : accent ? [37, 99, 235, 255] : [30, 58, 138, 255],
        offset,
      );
    }
  }
  return pixels;
}

function pressedCharacter(notification: Notification): string | undefined {
  if (
    notification.kind !== "event" ||
    notification.event.kind !== "key" ||
    notification.event.state !== "pressed" ||
    notification.event.key.kind !== "character"
  ) {
    return undefined;
  }
  return notification.event.key.value.toLowerCase();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
