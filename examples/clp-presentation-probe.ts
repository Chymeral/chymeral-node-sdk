import { performance } from "node:perf_hooks";

import {
  Client,
  type CloseReason,
  type NodeHandle,
  type Notification,
  type PresentationId,
  type Resize,
  type Vec2,
} from "../src/index.js";

const PANEL_WIDTH = 260;
const PANEL_HEIGHT = 150;
const PANEL_PADDING = 16;
const CONTROL_WIDTH = 120;
const CONTROL_HEIGHT = 12;
const BENCHMARK_UPDATES = 180;
const BENCHMARK_INTERVAL_MS = 1_000 / 60;
const MAX_TRACKED_PRESENTATIONS = 1_024;

interface ProbeNodes {
  readonly parent: NodeHandle;
  readonly control: NodeHandle;
  readonly label: NodeHandle;
}

interface PresentationMetrics {
  issued: number;
  presented: number;
  superseded: number;
  rejected: number;
  samplesMs: number[];
}

class PresentationProbe {
  private viewport: Resize = {
    physicalWidth: 800,
    physicalHeight: 600,
    logicalWidth: 800,
    logicalHeight: 600,
    scaleFactor: 1,
  };
  private pointer: Vec2 = { x: 210, y: 220 };
  private scrollOffset = 0;
  private benchmarkTimer: NodeJS.Timeout | undefined;
  private readonly sentAt = new Map<PresentationId, number>();
  private readonly metrics: PresentationMetrics = {
    issued: 0,
    presented: 0,
    superseded: 0,
    rejected: 0,
    samplesMs: [],
  };

  public constructor(
    private readonly client: Client,
    private readonly nodes: ProbeNodes,
  ) {}

  public handle(notification: Notification): boolean {
    switch (notification.kind) {
      case "resize":
        this.viewport = notification.resize;
        this.present("resize");
        return false;
      case "presentation_status":
        this.recordStatus(
          notification.presentation.presentationId,
          notification.presentation.status,
        );
        if (notification.presentation.status === "rejected") {
          console.error(
            `Presentation rejected: ${notification.presentation.code ?? "unknown"}: ${notification.presentation.message ?? "no message"}`,
          );
        }
        return false;
      case "event":
        return this.handleEvent(notification);
      case "closing":
      case "closed":
        throw new Error(`session closed: ${describeCloseReason(notification.reason)}`);
      case "delivery_gap":
      case "frame":
      case "tick":
        return false;
    }
  }

  public stop(): void {
    if (this.benchmarkTimer !== undefined) {
      clearInterval(this.benchmarkTimer);
      this.benchmarkTimer = undefined;
    }
  }

  public report(): void {
    const { issued, presented, superseded, rejected, samplesMs } = this.metrics;
    const percentile = (fraction: number): number | undefined => {
      if (samplesMs.length === 0) {
        return undefined;
      }
      const sorted = [...samplesMs].sort((first, second) => first - second);
      return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
    };
    const p50 = percentile(0.5);
    const p95 = percentile(0.95);
    console.log(
      `Presentation probe: issued=${issued}, presented=${presented}, superseded=${superseded}, rejected=${rejected}, observed app-submit-to-status p50=${formatMilliseconds(p50)}, p95=${formatMilliseconds(p95)}.`,
    );
    console.log(
      "Status timing ends at Chymeral's host presentation status; it is not physical scanout timing. Enable CHYMERAL_PRESENTATION_TRACE=1 on the host for transport-to-present-call diagnostics.",
    );
  }

  private handleEvent(notification: Extract<Notification, { readonly kind: "event" }>): boolean {
    const event = notification.event;
    if (event.kind === "key" && event.state === "pressed" && event.key.kind === "character") {
      const key = event.key.value.toLowerCase();
      if (key === "q") {
        return true;
      }
      if (key === "b") {
        this.startBenchmark();
        return false;
      }
    }
    if (event.kind === "pointer_move") {
      this.pointer = event.position;
      this.present("pointer");
      return false;
    }
    if (event.kind === "scroll") {
      this.pointer = event.position;
      const multiplier = event.unit === "line" ? 18 : 1;
      this.scrollOffset += event.delta.y * multiplier;
      this.present("scroll");
    }
    return false;
  }

  private present(source: string): void {
    const panelX = clamp(
      this.pointer.x - PANEL_WIDTH / 2,
      PANEL_PADDING,
      Math.max(PANEL_PADDING, this.viewport.logicalWidth - PANEL_WIDTH - PANEL_PADDING),
    );
    const panelY = clamp(
      this.pointer.y - PANEL_HEIGHT / 2 + this.scrollOffset,
      PANEL_PADDING,
      Math.max(PANEL_PADDING, this.viewport.logicalHeight - PANEL_HEIGHT - PANEL_PADDING),
    );
    const controlX = clamp(
      panelX,
      PANEL_PADDING,
      Math.max(PANEL_PADDING, this.viewport.logicalWidth - CONTROL_WIDTH - PANEL_PADDING),
    );
    const controlY = clamp(
      panelY + PANEL_HEIGHT + 20,
      PANEL_PADDING,
      Math.max(PANEL_PADDING, this.viewport.logicalHeight - CONTROL_HEIGHT - PANEL_PADDING),
    );
    const presentationId = this.client.presentScene([
      { node: this.nodes.parent, properties: { x: panelX, y: panelY } },
      { node: this.nodes.control, properties: { x: controlX, y: controlY } },
    ]);
    this.sentAt.set(presentationId, performance.now());
    this.metrics.issued += 1;
    while (this.sentAt.size > MAX_TRACKED_PRESENTATIONS) {
      const oldest = this.sentAt.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.sentAt.delete(oldest);
    }
    if (this.metrics.issued % 60 === 0) {
      console.log(`Presentation packet ${this.metrics.issued} submitted from ${source}.`);
    }
  }

  private startBenchmark(): void {
    this.stop();
    let index = 0;
    console.log(
      `Benchmark started: ${BENCHMARK_UPDATES} coalescible parent/control packets at 60 Hz. Move the pointer or resize the window while it runs if desired.`,
    );
    this.benchmarkTimer = setInterval(() => {
      if (index >= BENCHMARK_UPDATES) {
        this.stop();
        console.log(
          "Benchmark submission phase complete. Press q to print the observed summary and close.",
        );
        return;
      }
      const phase = index / 12;
      this.pointer = {
        x: this.viewport.logicalWidth / 2 + Math.sin(phase) * 180,
        y: this.viewport.logicalHeight / 2 + Math.cos(phase * 0.7) * 90,
      };
      this.scrollOffset = Math.sin(phase * 0.4) * 32;
      try {
        this.present("benchmark");
      } catch (error) {
        this.stop();
        console.error(error instanceof Error ? error.message : error);
      }
      index += 1;
    }, BENCHMARK_INTERVAL_MS);
  }

  private recordStatus(
    presentationId: PresentationId,
    status: "presented" | "rejected" | "superseded",
  ): void {
    const sentAt = this.sentAt.get(presentationId);
    this.sentAt.delete(presentationId);
    switch (status) {
      case "presented":
        this.metrics.presented += 1;
        if (sentAt !== undefined) {
          this.metrics.samplesMs.push(performance.now() - sentAt);
        }
        break;
      case "superseded":
        this.metrics.superseded += 1;
        break;
      case "rejected":
        this.metrics.rejected += 1;
        break;
    }
  }
}

async function main(): Promise<void> {
  let client: Client | undefined;
  let nodes: ProbeNodes | undefined;
  let probe: PresentationProbe | undefined;
  try {
    client = await Client.connectFromEnv();
    if (!client.hasCapability("presentation")) {
      throw new Error(
        "the connected host did not grant CLP v2.1 presentation; run this probe in Chymeral 1.5.0 or newer",
      );
    }
    await client.subscribe(["raw_input"]);
    nodes = await createProbeNodes(client);
    probe = new PresentationProbe(client, nodes);

    console.log(
      "CLP v2.1 presentation probe connected. Click the blue panel once to focus this session, then move the pointer or scroll.",
    );
    console.log(
      "Each input sample submits one atomic parent/control packet. Press b for a 180-update 60 Hz burst, or q to close only this session.",
    );
    for (;;) {
      if (probe.handle(await client.nextNotification())) {
        break;
      }
    }
    probe.report();
  } finally {
    probe?.stop();
    if (client !== undefined && nodes !== undefined) {
      await client.removeNode(nodes.control).catch(() => undefined);
      await client.removeNode(nodes.label).catch(() => undefined);
      await client.removeNode(nodes.parent).catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
  }
}

async function createProbeNodes(client: Client): Promise<ProbeNodes> {
  const parent = await client.createNode(
    {
      kind: "empty",
      properties: { x: 80, y: 120, width: PANEL_WIDTH, height: PANEL_HEIGHT },
    },
    { layer: "overlay" },
  );
  await client.createNode(
    {
      kind: "rectangle",
      properties: { x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT },
      color: [37, 99, 235, 225],
    },
    { parent: parent.node },
  );
  await client.createNode(
    {
      kind: "rectangle",
      properties: { x: 16, y: 48, width: PANEL_WIDTH - 32, height: 72 },
      color: [30, 58, 138, 200],
    },
    { parent: parent.node },
  );
  const label = await client.createNode(
    {
      kind: "text",
      properties: { x: 16, y: 16 },
      text: "frame-paced parent\n+ sibling control",
      style: { color: [255, 255, 255, 255], weight: "bold" },
    },
    { parent: parent.node },
  );
  const control = await client.createNode(
    {
      kind: "rectangle",
      properties: { x: 80, y: 290, width: CONTROL_WIDTH, height: CONTROL_HEIGHT },
      color: [244, 114, 182, 255],
    },
    { layer: "overlay" },
  );
  return { parent: parent.node, control: control.node, label: label.node };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(2)} ms`;
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
