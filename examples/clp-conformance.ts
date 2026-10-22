import { Client, type CloseReason, type Notification, type TextMetrics } from "../src/index.js";

const ALPHA_TOGGLE_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e,
  0x30, 0x03, 0x01, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x96, 0x00, 0x00, 0x00, 0x2c, 0x00,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x21, 0xf9, 0x04,
  0x00, 0x96, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0xfb,
  0x71, 0x85, 0x00, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
const TIMING_CONFORMANCE_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  let client: Client | undefined;
  try {
    client = await Client.connectFromEnv();
    await client.subscribe(["raw_input", "terminal", "timing"]);
    await requireTiming(client);

    const image = await client.uploadImage({
      kind: "rgba8",
      width: 1,
      height: 1,
      pixels: Uint8Array.from([30, 150, 240, 255]),
    });
    if (client.hasCapability("window_metadata")) {
      const initial = await client.setWindowMetadata({
        title: "Chymeral Node SDK conformance",
        icon: image,
      });
      const support = client.session.context.windowMetadata;
      if (support !== undefined && initial.iconSupported !== support.iconSupported) {
        throw new Error("window metadata support disagreed with its command result");
      }
      await client.setWindowMetadata({ title: "Chymeral Node SDK conformance refreshed" });
      await client.setWindowMetadata({ title: null, icon: null });
    }
    const visual = await client.createNode(
      {
        kind: "image",
        properties: { x: 16, y: 16, width: 1, height: 1 },
        image,
        contactShape: { kind: "alpha", threshold: 1 },
      },
      { layer: "overlay" },
    );
    const animatedImage = await client.uploadImage({ kind: "gif", bytes: ALPHA_TOGGLE_GIF });
    await client.setNode(visual.node, {
      visual: {
        kind: "image",
        image: animatedImage,
        opacity: 0.75,
        contactShape: { kind: "alpha", threshold: 1 },
      },
    });
    await client.setNode(visual.node, {
      visual: { kind: "rectangle", color: [30, 150, 240, 255] },
    });

    const text = await client.createNode(
      {
        kind: "text",
        properties: { x: 32, y: 32 },
        text: "a\tb\n界",
      },
      { layer: "overlay" },
    );
    requireMetrics(text.textMetrics, 9, 2, "text node creation");
    const updatedText = await client.setNode(text.node, { text: "updated\n" });
    requireMetrics(updatedText, 7, 2, "text node update");
    const styledText = await client.setNode(text.node, { textStyle: { size: 20 } });
    requireValidStyledMetrics(styledText, updatedText);

    const collider = await client.createNode(
      {
        kind: "empty",
        properties: {
          x: 220,
          y: 80,
          width: 40,
          height: 40,
          visible: false,
          overlapEnabled: true,
        },
      },
      { layer: "overlay" },
    );
    const mover = await client.createNode(
      {
        kind: "empty",
        properties: {
          x: 80,
          y: 80,
          width: 40,
          height: 40,
          visible: false,
          overlapEnabled: true,
        },
      },
      { layer: "overlay" },
    );
    await client.setNode(mover.node, { properties: { x: 230 } });
    const overlaps = await client.getOverlaps(mover.node);
    if (!(await client.isOverlapping(mover.node)) || !overlaps.includes(collider.node)) {
      throw new Error("overlap query did not report the enabled same-session collider");
    }

    if (process.argv.includes("--manual")) {
      await manualInteractionDemo(client);
    }

    await client.removeNode(mover.node);
    await client.removeNode(collider.node);
    await client.removeNode(text.node);
    await client.removeNode(visual.node);
    await client.removeImage(image);
    await client.removeImage(animatedImage);
    const reason = await client.close();
    if (reason.kind !== "client_requested") {
      throw new Error(`unexpected close reason: ${describeCloseReason(reason)}`);
    }

    console.log(
      `CLP v${client.session.protocolVersion.major}.${client.session.protocolVersion.minor} conformance client passed.`,
    );
  } catch (error) {
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
    throw error;
  }
}

async function requireTiming(client: Client): Promise<void> {
  const deadline = Date.now() + TIMING_CONFORMANCE_TIMEOUT_MS;
  let ticks = 0;
  while (ticks < 2) {
    const notification = await nextBeforeDeadline(client.nextNotification(), deadline);
    if (notification.kind === "tick") {
      ticks += 1;
    }
    if (notification.kind === "closing" || notification.kind === "closed") {
      throw new Error(
        `session closed during timing conformance: ${describeCloseReason(notification.reason)}`,
      );
    }
  }
}

async function manualInteractionDemo(client: Client): Promise<void> {
  const externalDropEnabled = client.hasCapability("external_drop");
  const image = await client.uploadImage({
    kind: "rgba8",
    width: 140,
    height: 90,
    pixels: alphaFramePixels(140, 90),
  });
  const base = await client.createNode(
    {
      kind: "rectangle",
      properties: {
        x: 80,
        y: 180,
        width: 280,
        height: 180,
        overlapEnabled: true,
        externalDropEnabled,
      },
      color: [37, 99, 235, 230],
    },
    { layer: "overlay" },
  );
  const alpha = await client.createNode(
    {
      kind: "image",
      properties: {
        x: 150,
        y: 240,
        width: 140,
        height: 90,
        zIndex: 1,
        overlapEnabled: true,
        externalDropEnabled,
      },
      image,
      contactShape: { kind: "alpha", threshold: 1 },
    },
    { layer: "overlay" },
  );
  const animatedImage = await client.uploadImage({ kind: "gif", bytes: ALPHA_TOGGLE_GIF });
  const animatedAlpha = await client.createNode(
    {
      kind: "image",
      properties: {
        x: 300,
        y: 240,
        width: 50,
        height: 90,
        zIndex: 2,
        overlapEnabled: true,
        externalDropEnabled,
      },
      image: animatedImage,
      contactShape: { kind: "alpha", threshold: 1 },
    },
    { layer: "overlay" },
  );
  const passthrough = await client.createNode(
    {
      kind: "rectangle",
      properties: {
        x: 80,
        y: 180,
        width: 280,
        height: 36,
        zIndex: 3,
        externalDropEnabled,
        inputPassthrough: true,
      },
      color: [255, 255, 255, 120],
    },
    { layer: "overlay" },
  );

  console.log("M20 manual interaction scene is ready.");
  console.log(
    "- Click the blue area or transparent orange-frame center: the blue node receives the event.",
  );
  console.log("- Click or drag the orange frame itself: the alpha image receives the event.");
  console.log("- The pink tile alternates between opaque and transparent every 1.5 seconds.");
  console.log(
    "- Click the white top band: it is visible but input-passthrough, so blue receives it.",
  );
  if (externalDropEnabled) {
    console.log("- Drop a desktop file on each region to inspect alpha and passthrough targeting.");
  } else {
    console.log(
      "- This backend did not grant external_drop; pointer and overlap checks remain available.",
    );
  }
  console.log("Click a scene node, then press q to close only this conformance session.");

  for (;;) {
    const notification = await client.nextNotification();
    if (isQuitKey(notification)) {
      break;
    }
    if (notification.kind === "event" && notification.event.kind === "scene") {
      console.log("Scene event:", notification.event.event);
    }
    if (notification.kind === "closing" || notification.kind === "closed") {
      throw new Error(
        `session closed during manual validation: ${describeCloseReason(notification.reason)}`,
      );
    }
  }

  await client.removeNode(passthrough.node);
  await client.removeNode(animatedAlpha.node);
  await client.removeNode(alpha.node);
  await client.removeNode(base.node);
  await client.removeImage(animatedImage);
  await client.removeImage(image);
}

function alphaFramePixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const border = x < 12 || y < 12 || x >= width - 12 || y >= height - 12;
      pixels.set([249, 115, 22, border ? 255 : 0], offset);
    }
  }
  return pixels;
}

function isQuitKey(notification: Notification): boolean {
  return (
    notification.kind === "event" &&
    notification.event.kind === "key" &&
    notification.event.state === "pressed" &&
    notification.event.key.kind === "character" &&
    notification.event.key.value.toLowerCase() === "q"
  );
}

function requireMetrics(
  metrics: TextMetrics | undefined,
  columns: number,
  rows: number,
  operation: string,
): asserts metrics is TextMetrics {
  if (metrics === undefined || metrics.columns !== columns || metrics.rows !== rows) {
    throw new Error(`${operation} did not follow terminal-cell layout`);
  }
}

function requireValidStyledMetrics(
  metrics: TextMetrics | undefined,
  previous: TextMetrics | undefined,
): asserts metrics is TextMetrics {
  if (
    metrics === undefined ||
    previous === undefined ||
    metrics.columns !== previous.columns ||
    metrics.rows !== previous.rows ||
    !Number.isFinite(metrics.width) ||
    !Number.isFinite(metrics.height) ||
    metrics.width <= 0 ||
    metrics.height <= 0
  ) {
    throw new Error("text style update returned invalid intrinsic metrics");
  }
}

function nextBeforeDeadline<T>(notification: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      new Error(
        `timing subscription did not deliver a tick within ${TIMING_CONFORMANCE_TIMEOUT_MS / 1_000} seconds`,
      ),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () =>
        finish(() => {
          reject(
            new Error(
              `timing subscription did not deliver a tick within ${TIMING_CONFORMANCE_TIMEOUT_MS / 1_000} seconds`,
            ),
          );
        }),
      remaining,
    );
    void notification.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function describeCloseReason(reason: CloseReason): string {
  return reason.kind === "program_fault"
    ? `${reason.kind} (${reason.phase}: ${reason.message})`
    : reason.kind;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
