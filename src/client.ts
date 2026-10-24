import { AsyncQueue } from "./async-queue.js";
import {
  CapabilityNotGrantedError,
  CommandError,
  HostError,
  InvalidInputError,
  MissingEnvironmentError,
  ProtocolError,
  SessionClosedError,
} from "./errors.js";
import { SceneBatch } from "./scene-batch.js";
import { FramedTransport } from "./transport.js";
import {
  ALL_CAPABILITIES,
  BINARY_FRAGMENT_BYTES,
  CLP_PROTOCOL_VERSION,
  ENDPOINT_ENV,
  MAX_PRESENTATION_PACKET_BYTES,
  MAX_PRESENTATION_UPDATES,
  MAX_SCENE_BATCH_BYTES,
  MAX_SCENE_BATCH_OPERATIONS,
  TOKEN_ENV,
  type Capability,
  type CloseReason,
  type CreateNodeOptions,
  type CreatedNode,
  type ImageHandle,
  type ImageUpload,
  type NodeChanges,
  type NodeHandle,
  type NodeInput,
  type NodePropertiesPatch,
  type NodeVisual,
  type Notification,
  type PresentationId,
  type PresentationUpdate,
  type ProgramPhase,
  type ProtocolVersion,
  type SceneBatchNodeChanges,
  type SceneBatchOperation,
  type SceneBatchResult,
  type SessionInfo,
  type Subscription,
  type TextMetrics,
  type TextStyle,
  type WindowMetadataPatch,
  type WindowMetadataStatus,
} from "./types.js";

import {
  normalizeCapabilities,
  normalizeSubscriptions,
  serializeNodeInput,
  serializeNodeChanges,
  serializeSceneBatchNodeChanges,
  serializeBatchNodeRef,
  validateBatchNodeParent,
  validateSceneBatchAlias,
  serializePresentationUpdate,
  serializeImageUpload,
  decodePresentationStatus,
  decodeInitContext,
  decodeProtocolVersion,
  decodeCapabilities,
  decodeSubscriptions,
  decodeDeliveryCategories,
  decodeEvent,
  decodeResize,
  decodeCloseReason,
  decodeDuration,
  decodeSceneBatchResult,
  decodeOptionalTextMetrics,
  decodeSessionId,
  decodeNodeHandle,
  decodeImageHandle,
  validateNodeHandle,
  validateImageHandle,
  serializeWindowMetadataPatch,
  validatePresentationId,
  validateNodeProperties,
  validateTextNodeProperties,
  validateNodePropertiesPatch,
  validateNodeVisual,
  validateNodeParent,
  validateContactShape,
  validateTextStyle,
  validateText,
  validateColor,
  validateOpacity,
  validateSceneLayer,
  validateProgramPhase,
  messageType,
  hostError,
  unexpectedMessage,
  unexpectedCommandResult,
  recordField,
  stringField,
  booleanField,
  array,
  arrayField,
  assertNever,
} from "./codec.js";

const MAX_PENDING_NOTIFICATIONS = 4_096;
const CLP_PROTOCOL_V2_0: ProtocolVersion = { major: 2, minor: 0 };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface PendingCommand {
  readonly requestId: string;
  readonly deferred: Deferred<Record<string, unknown>>;
}

interface PendingPresentation {
  readonly presentationId: PresentationId;
  readonly updates: readonly Record<string, unknown>[];
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * An asynchronous, dependency-free CLP v2.4 client for Node.js.
 *
 * `connectFromEnv` completes the `hello → init → init_complete → start →
 * started` lifecycle before resolving. Commands are serialized so a binary
 * image upload cannot interleave with another CLP command.
 */
export class Client {
  private readonly notificationQueue = new AsyncQueue<Notification>(MAX_PENDING_NOTIFICATIONS);
  private readonly sessionInfo: SessionInfo;
  private operationTail: Promise<void> = Promise.resolve();
  private nextRequest = 1;
  private nextPresentation = 1;
  private pendingCommand: PendingCommand | undefined;
  private pendingPresentation: PendingPresentation | undefined;
  private presentationFlush: Promise<void> | undefined;
  private pendingSubscription: Deferred<readonly Subscription[]> | undefined;
  private pendingClose: Deferred<CloseReason> | undefined;
  private closedReason: CloseReason | undefined;
  private failure: Error | undefined;

  private constructor(
    private readonly transport: FramedTransport,
    sessionInfo: SessionInfo,
  ) {
    this.sessionInfo = {
      protocolVersion: { ...sessionInfo.protocolVersion },
      sessionId: sessionInfo.sessionId,
      capabilities: new Set(sessionInfo.capabilities),
      context: {
        arguments: [...sessionInfo.context.arguments],
        initialCommands: sessionInfo.context.initialCommands.map((command) => ({
          name: command.name,
          arguments: [...command.arguments],
        })),
        ...(sessionInfo.context.windowMetadata === undefined
          ? {}
          : { windowMetadata: { ...sessionInfo.context.windowMetadata } }),
      },
    };
    void this.pump();
  }

  /** Connects using the private endpoint and token inherited from Chymeral. */
  public static async connectFromEnv(
    requestedCapabilities: Iterable<Capability> = ALL_CAPABILITIES,
  ): Promise<Client> {
    const endpoint = process.env[ENDPOINT_ENV];
    if (endpoint === undefined || endpoint.length === 0) {
      throw new MissingEnvironmentError(ENDPOINT_ENV);
    }
    const token = process.env[TOKEN_ENV];
    if (token === undefined || token.length === 0) {
      throw new MissingEnvironmentError(TOKEN_ENV);
    }
    return Client.connect(endpoint, token, requestedCapabilities);
  }

  /** Connects to an explicit endpoint. This is intended for launchers and tests. */
  public static async connect(
    endpoint: string,
    token: string,
    requestedCapabilities: Iterable<Capability> = ALL_CAPABILITIES,
  ): Promise<Client> {
    if (token.length === 0) {
      throw new InvalidInputError("the CLP token may not be empty");
    }
    const capabilities = normalizeCapabilities(requestedCapabilities);
    try {
      return await Client.connectOnce(endpoint, token, capabilities, CLP_PROTOCOL_VERSION);
    } catch (error) {
      if (
        error instanceof HostError &&
        (error.code === "unsupported_version" || error.code === "invalid_message")
      ) {
        // CLP v2.0 hosts predate v2.1 presentation/window metadata and v2.4
        // scene batches. They can reject newer enum values before version
        // negotiation, so retry once with the frozen v2.0 capability set.
        return Client.connectOnce(
          endpoint,
          token,
          capabilities.filter(
            (capability) =>
              capability !== "presentation" &&
              capability !== "window_metadata" &&
              capability !== "scene_batch",
          ),
          CLP_PROTOCOL_V2_0,
        );
      }
      throw error;
    }
  }

  private static async connectOnce(
    endpoint: string,
    token: string,
    capabilities: readonly Capability[],
    requestedProtocol: ProtocolVersion,
  ): Promise<Client> {
    const transport = await FramedTransport.connect(endpoint);

    try {
      await transport.sendJson({
        type: "hello",
        protocol: requestedProtocol,
        token,
        capabilities,
      });

      const init = await transport.nextMessage();
      if (messageType(init) === "error") {
        throw hostError(init);
      }
      if (messageType(init) !== "init") {
        throw unexpectedMessage("init", init);
      }

      const protocol = decodeProtocolVersion(init.protocol, "init.protocol");
      if (protocol.major !== requestedProtocol.major || protocol.minor > requestedProtocol.minor) {
        throw new ProtocolError(
          `host negotiated unsupported version ${protocol.major}.${protocol.minor}; requested ${requestedProtocol.major}.${requestedProtocol.minor}`,
        );
      }
      const sessionId = decodeSessionId(init.session_id, "init.session_id");
      const grantedCapabilities = new Set(
        decodeCapabilities(init.capabilities, "init.capabilities"),
      );
      const context = decodeInitContext(init.context);

      await transport.sendJson({ type: "init_complete" });
      const start = await transport.nextMessage();
      if (messageType(start) === "error") {
        throw hostError(start);
      }
      if (messageType(start) !== "start") {
        throw unexpectedMessage("start", start);
      }
      if (decodeSessionId(start.session_id, "start.session_id") !== sessionId) {
        throw new ProtocolError("start belongs to a different CLP session");
      }
      await transport.sendJson({ type: "started" });

      return new Client(transport, {
        protocolVersion: protocol,
        sessionId,
        capabilities: grantedCapabilities,
        context,
      });
    } catch (error) {
      transport.dispose();
      throw error;
    }
  }

  /** Immutable data negotiated before this session began running. */
  public get session(): SessionInfo {
    return {
      protocolVersion: { ...this.sessionInfo.protocolVersion },
      sessionId: this.sessionInfo.sessionId,
      capabilities: new Set(this.sessionInfo.capabilities),
      context: {
        arguments: [...this.sessionInfo.context.arguments],
        initialCommands: this.sessionInfo.context.initialCommands.map((command) => ({
          name: command.name,
          arguments: [...command.arguments],
        })),
        ...(this.sessionInfo.context.windowMetadata === undefined
          ? {}
          : { windowMetadata: { ...this.sessionInfo.context.windowMetadata } }),
      },
    };
  }

  /** Returns whether the host granted a capability. */
  public hasCapability(capability: Capability): boolean {
    return this.sessionInfo.capabilities.has(capability);
  }

  /** Replaces notification subscriptions and returns the effective host set. */
  public subscribe(subscriptions: Iterable<Subscription>): Promise<readonly Subscription[]> {
    const requested = normalizeSubscriptions(subscriptions);
    for (const subscription of requested) {
      if (subscription === "timing") {
        this.requireCapability("timing");
      } else {
        this.requireCapability("input");
      }
    }

    return this.enqueue(async () => {
      this.ensureOpen();
      const pending = deferred<readonly Subscription[]>();
      this.pendingSubscription = pending;
      try {
        await this.transport.sendJson({ type: "subscribe", subscriptions: requested });
        return await pending.promise;
      } finally {
        if (this.pendingSubscription === pending) {
          this.pendingSubscription = undefined;
        }
      }
    });
  }

  /** Creates a root or child node in this session's implicit scene tree. */
  public async createNode(node: NodeInput, options: CreateNodeOptions = {}): Promise<CreatedNode> {
    this.requireNodeInput(node);
    if (options.parent !== undefined && options.layer !== undefined) {
      throw new InvalidInputError("a child node may not specify a root layer");
    }

    const command: Record<string, unknown> = {
      op: "create_node",
      node: serializeNodeInput(node),
    };
    if (options.parent !== undefined) {
      command.parent = validateNodeHandle(options.parent, "parent");
    }
    if (options.layer !== undefined) {
      command.layer = validateSceneLayer(options.layer, "layer");
    }

    const result = await this.command(command);
    if (stringField(result, "kind", "command result") !== "node") {
      throw unexpectedCommandResult("node", result);
    }
    const created: CreatedNode = {
      node: decodeNodeHandle(result.node, "command result.node"),
    };
    const textMetrics = decodeOptionalTextMetrics(
      result.text_metrics,
      "command result.text_metrics",
    );
    return textMetrics === undefined ? created : { ...created, textMetrics };
  }

  /** Atomically changes selected node properties, hierarchy, visual data, or text. */
  public async setNode(node: NodeHandle, changes: NodeChanges): Promise<TextMetrics | undefined> {
    this.requireNodeChanges(changes);
    const result = await this.command({
      op: "set_node",
      node: validateNodeHandle(node, "node"),
      changes: serializeNodeChanges(changes),
    });
    if (stringField(result, "kind", "command result") !== "node_updated") {
      throw unexpectedCommandResult("node_updated", result);
    }
    return decodeOptionalTextMetrics(result.text_metrics, "command result.text_metrics");
  }

  /**
   * Commits a bounded ordered scene batch as one retained-state transition.
   *
   * Local aliases can only reference nodes created by earlier operations. A
   * host that does not grant `scene_batch` causes `CapabilityNotGrantedError`;
   * the SDK deliberately does not replay the batch as visible sequential
   * commands.
   */
  public async applySceneBatch(batch: SceneBatch): Promise<SceneBatchResult> {
    this.requireCapability("scene");
    this.requireCapability("scene_batch");
    const operations = this.serializeSceneBatch(batch.operations);
    const result = await this.command(
      { op: "scene_batch", operations },
      undefined,
      MAX_SCENE_BATCH_BYTES,
    );
    if (stringField(result, "kind", "command result") !== "scene_batch") {
      throw unexpectedCommandResult("scene_batch", result);
    }
    return decodeSceneBatchResult(result);
  }

  /**
   * Coalesces transient node geometry into the newest frame-presentation
   * packet. It returns immediately without awaiting a command response; the
   * host later emits a `presentation_status` notification.
   *
   * This method never turns a packet into individual `setNode` calls when a
   * CLP v2.0 host is negotiated. It throws `CapabilityNotGrantedError` for
   * `presentation` instead.
   */
  public presentScene(updates: Iterable<PresentationUpdate>): PresentationId {
    const presentationId = this.nextPresentationIdentifier();
    this.presentSceneWithId(presentationId, updates);
    return presentationId;
  }

  /** Sends a presentation packet with an application-supplied identifier. */
  public presentSceneWithId(presentationId: string, updates: Iterable<PresentationUpdate>): void {
    this.requireCapability("scene");
    this.requireCapability("presentation");
    this.ensureOpen();
    const serializedUpdates = Array.from(updates, (update, index) =>
      serializePresentationUpdate(update, `updates[${index}]`),
    );
    if (serializedUpdates.length === 0) {
      throw new InvalidInputError("a presentation packet requires at least one update");
    }
    if (serializedUpdates.length > MAX_PRESENTATION_UPDATES) {
      throw new InvalidInputError(
        `a presentation packet may update at most ${MAX_PRESENTATION_UPDATES} nodes`,
      );
    }
    const nodeHandles = new Set<string>();
    for (const update of serializedUpdates) {
      const node = stringField(update, "node", "presentation update");
      if (nodeHandles.has(node)) {
        throw new InvalidInputError(`a presentation packet updates ${node} more than once`);
      }
      nodeHandles.add(node);
    }
    const checkedPresentationId = validatePresentationId(presentationId, "presentationId");
    const wire = {
      type: "present_scene",
      presentation_id: checkedPresentationId,
      updates: serializedUpdates,
    };
    if (Buffer.byteLength(JSON.stringify(wire), "utf8") > MAX_PRESENTATION_PACKET_BYTES) {
      throw new InvalidInputError(
        `a presentation packet may not exceed ${MAX_PRESENTATION_PACKET_BYTES} bytes`,
      );
    }
    this.pendingPresentation = {
      presentationId: checkedPresentationId,
      updates: serializedUpdates,
    };
    this.schedulePresentationFlush();
  }

  /** Removes a node and all of its descendants. */
  public async removeNode(node: NodeHandle): Promise<void> {
    this.requireCapability("scene");
    await this.expectAcknowledged(
      this.command({ op: "remove_node", node: validateNodeHandle(node, "node") }),
    );
  }

  /** Uploads RGBA8 pixels or encoded GIF bytes and returns an opaque image handle. */
  public async uploadImage(image: ImageUpload): Promise<ImageHandle> {
    this.requireCapability("images");
    const { source, bytes } = serializeImageUpload(image);
    const result = await this.command({ op: "upload_image", source }, bytes);
    if (stringField(result, "kind", "command result") !== "image") {
      throw unexpectedCommandResult("image", result);
    }
    return decodeImageHandle(result.image, "command result.image");
  }

  /** Removes an unreferenced session-owned image. */
  public async removeImage(image: ImageHandle): Promise<void> {
    this.requireCapability("images");
    await this.expectAcknowledged(
      this.command({ op: "remove_image", image: validateImageHandle(image, "image") }),
    );
  }

  /**
   * Updates this session's application window title and/or icon claim.
   *
   * Omitted fields preserve their current values; `null` clears a field. An
   * icon must be a session-owned, static RGBA8 image uploaded through this
   * client. Hosts report whether their active window backend can apply icons.
   */
  public async setWindowMetadata(metadata: WindowMetadataPatch): Promise<WindowMetadataStatus> {
    this.requireCapability("window_metadata");
    const result = await this.command(serializeWindowMetadataPatch(metadata));
    if (stringField(result, "kind", "command result") !== "window_metadata") {
      throw unexpectedCommandResult("window_metadata", result);
    }
    return { iconSupported: booleanField(result, "icon_supported", "command result") };
  }

  /** Returns whether any enabled same-session node overlaps `node`. */
  public async isOverlapping(node: NodeHandle): Promise<boolean> {
    this.requireCapability("scene");
    this.requireCapability("overlap");
    const result = await this.command({
      op: "is_overlapping",
      node: validateNodeHandle(node, "node"),
    });
    if (stringField(result, "kind", "command result") !== "is_overlapping") {
      throw unexpectedCommandResult("is_overlapping", result);
    }
    return booleanField(result, "overlapping", "command result");
  }

  /** Returns enabled same-session nodes currently overlapping `node`. */
  public async getOverlaps(node: NodeHandle): Promise<readonly NodeHandle[]> {
    this.requireCapability("scene");
    this.requireCapability("overlap");
    const result = await this.command({
      op: "get_overlaps",
      node: validateNodeHandle(node, "node"),
    });
    if (stringField(result, "kind", "command result") !== "overlaps") {
      throw unexpectedCommandResult("overlaps", result);
    }
    return arrayField(result, "nodes", "command result").map((value, index) =>
      decodeNodeHandle(value, `command result.nodes[${index}]`),
    );
  }

  /** Resolves with the next pending or incoming host notification. */
  public nextNotification(): Promise<Notification> {
    return this.notificationQueue.take();
  }

  /** Returns an already queued notification without waiting for I/O. */
  public tryNextNotification(): Notification | undefined {
    return this.notificationQueue.tryTake();
  }

  /** Iterates notifications in arrival order until the session closes or fails. */
  public async *notifications(): AsyncGenerator<Notification> {
    for (;;) {
      const notification = await this.nextNotification();
      yield notification;
      if (notification.kind === "closed") {
        return;
      }
    }
  }

  /** Reports an application fault and waits for Chymeral's final close reason. */
  public reportFault(phase: ProgramPhase, message: string): Promise<CloseReason> {
    validateProgramPhase(phase, "phase");
    if (message.length === 0) {
      throw new InvalidInputError("the fault message may not be empty");
    }
    return this.closeWith({ type: "fault", phase, message });
  }

  /** Requests clean session closure and waits for Chymeral's final close reason. */
  public close(): Promise<CloseReason> {
    return this.closeWith({ type: "close" });
  }

  private closeWith(message: Record<string, unknown>): Promise<CloseReason> {
    if (this.closedReason !== undefined) {
      return Promise.resolve(this.closedReason);
    }
    return this.enqueue(async () => {
      if (this.closedReason !== undefined) {
        return this.closedReason;
      }
      this.ensureOpen();
      const pending = deferred<CloseReason>();
      this.pendingClose = pending;
      try {
        await this.transport.sendJson(message);
        return await pending.promise;
      } finally {
        if (this.pendingClose === pending) {
          this.pendingClose = undefined;
        }
      }
    });
  }

  private command(
    command: Record<string, unknown>,
    binaryPayload?: Uint8Array,
    maximumJsonBytes?: number,
  ): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      this.ensureOpen();
      const requestId = `node-sdk-${this.nextRequest}`;
      this.nextRequest = this.nextRequest === Number.MAX_SAFE_INTEGER ? 1 : this.nextRequest + 1;
      const pending: PendingCommand = { requestId, deferred: deferred<Record<string, unknown>>() };
      this.pendingCommand = pending;
      try {
        const message = { type: "command", request_id: requestId, command };
        if (
          maximumJsonBytes !== undefined &&
          Buffer.byteLength(JSON.stringify(message), "utf8") > maximumJsonBytes
        ) {
          throw new InvalidInputError(`a scene batch may not exceed ${maximumJsonBytes} bytes`);
        }
        await this.transport.sendJson(message);
        if (binaryPayload !== undefined) {
          for (let offset = 0; offset < binaryPayload.byteLength; offset += BINARY_FRAGMENT_BYTES) {
            await this.transport.sendBinary(
              binaryPayload.subarray(
                offset,
                Math.min(offset + BINARY_FRAGMENT_BYTES, binaryPayload.byteLength),
              ),
            );
          }
        }
        return await pending.deferred.promise;
      } finally {
        if (this.pendingCommand === pending) {
          this.pendingCommand = undefined;
        }
      }
    });
  }

  private async expectAcknowledged(result: Promise<Record<string, unknown>>): Promise<void> {
    const value = await result;
    if (stringField(value, "kind", "command result") !== "acknowledged") {
      throw unexpectedCommandResult("acknowledged", value);
    }
  }

  private schedulePresentationFlush(): void {
    if (this.presentationFlush !== undefined) {
      return;
    }
    const flush = this.enqueue(async () => {
      try {
        this.ensureOpen();
        const presentation = this.pendingPresentation;
        this.pendingPresentation = undefined;
        if (presentation !== undefined) {
          await this.transport.sendJson({
            type: "present_scene",
            presentation_id: presentation.presentationId,
            updates: presentation.updates,
          });
        }
      } finally {
        this.presentationFlush = undefined;
        if (
          this.pendingPresentation !== undefined &&
          this.failure === undefined &&
          this.closedReason === undefined
        ) {
          this.schedulePresentationFlush();
        }
      }
    });
    this.presentationFlush = flush;
    void flush.catch((error: unknown) =>
      this.fail(error instanceof Error ? error : new ProtocolError(String(error))),
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        this.dispatch(await this.transport.nextMessage());
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolError(String(error)));
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    switch (messageType(message)) {
      case "result": {
        const requestId = stringField(message, "request_id", "result");
        if (this.pendingCommand === undefined || this.pendingCommand.requestId !== requestId) {
          throw new ProtocolError(`received result for ${requestId} without a matching command`);
        }
        this.pendingCommand.deferred.resolve(recordField(message, "result", "result"));
        return;
      }
      case "command_error": {
        const requestId = stringField(message, "request_id", "command_error");
        if (this.pendingCommand === undefined || this.pendingCommand.requestId !== requestId) {
          throw new ProtocolError(
            `received command_error for ${requestId} without a matching command`,
          );
        }
        this.pendingCommand.deferred.reject(
          new CommandError(
            requestId,
            stringField(message, "code", "command_error"),
            stringField(message, "message", "command_error"),
          ),
        );
        return;
      }
      case "subscribed": {
        this.expectSession(message, "subscribed");
        if (this.pendingSubscription === undefined) {
          throw new ProtocolError("received subscribed without a pending subscribe operation");
        }
        this.pendingSubscription.resolve(
          decodeSubscriptions(
            arrayField(message, "subscriptions", "subscribed"),
            "subscribed.subscriptions",
          ),
        );
        return;
      }
      case "event":
      case "tick":
      case "frame":
      case "resize":
      case "delivery_gap":
      case "presentation_status":
      case "closing":
      case "closed": {
        const notification = this.decodeNotification(message);
        this.notificationQueue.push(notification);
        if (notification.kind === "closed") {
          this.closedReason = notification.reason;
          this.pendingClose?.resolve(notification.reason);
          const closed = new SessionClosedError(notification.reason);
          this.pendingCommand?.deferred.reject(closed);
          this.pendingSubscription?.reject(closed);
          this.notificationQueue.close(closed);
          this.transport.dispose();
        }
        return;
      }
      case "error":
        throw hostError(message);
      default:
        throw unexpectedMessage("a running host notification or response", message);
    }
  }

  private decodeNotification(message: Record<string, unknown>): Notification {
    const type = messageType(message);
    this.expectSession(message, type);

    switch (type) {
      case "event":
        return { kind: "event", event: decodeEvent(message.event) };
      case "tick":
      case "frame":
        return { kind: type, dtNs: decodeDuration(message.dt_ns, `${type}.dt_ns`) };
      case "resize":
        return { kind: "resize", resize: decodeResize(message) };
      case "delivery_gap":
        return {
          kind: "delivery_gap",
          categories: decodeDeliveryCategories(
            arrayField(message, "categories", "delivery_gap"),
            "delivery_gap.categories",
          ),
        };
      case "presentation_status":
        return {
          kind: "presentation_status",
          presentation: decodePresentationStatus(message),
        };
      case "closing":
        return { kind: "closing", reason: decodeCloseReason(message.reason, "closing.reason") };
      case "closed":
        return { kind: "closed", reason: decodeCloseReason(message.reason, "closed.reason") };
      default:
        throw unexpectedMessage("a host notification", message);
    }
  }

  private expectSession(message: Record<string, unknown>, context: string): void {
    const sessionId = decodeSessionId(message.session_id, `${context}.session_id`);
    if (sessionId !== this.sessionInfo.sessionId) {
      throw new ProtocolError(
        `${context} belongs to ${sessionId}, expected ${this.sessionInfo.sessionId}`,
      );
    }
  }

  private ensureOpen(): void {
    if (this.closedReason !== undefined) {
      throw new SessionClosedError(this.closedReason);
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined || this.closedReason !== undefined) {
      return;
    }
    this.failure = error;
    this.pendingPresentation = undefined;
    this.pendingCommand?.deferred.reject(error);
    this.pendingSubscription?.reject(error);
    this.pendingClose?.reject(error);
    this.notificationQueue.close(error);
    this.transport.dispose();
  }

  private requireCapability(capability: Capability): void {
    if (!this.hasCapability(capability)) {
      throw new CapabilityNotGrantedError(capability);
    }
  }

  private requireNodeInput(node: NodeInput): void {
    this.requireCapability("scene");
    switch (node.kind) {
      case "empty":
      case "rectangle":
        validateNodeProperties(node.properties, "node.properties");
        this.requireNodePropertyCapabilities(node.properties);
        if (node.kind === "rectangle") {
          validateColor(node.color, "node.color");
        }
        return;
      case "image":
        this.requireCapability("images");
        validateNodeProperties(node.properties, "node.properties");
        this.requireNodePropertyCapabilities(node.properties);
        validateImageHandle(node.image, "node.image");
        validateOpacity(node.opacity, "node.opacity");
        validateContactShape(node.contactShape, "node.contactShape");
        return;
      case "text":
        this.requireCapability("text");
        validateTextNodeProperties(node.properties, "node.properties");
        this.requireNodePropertyCapabilities(node.properties);
        validateText(node.text, "node.text");
        validateTextStyle(node.style, "node.style");
        return;
      default:
        return assertNever(node);
    }
  }

  private requireNodeChanges(changes: NodeChanges): void {
    this.requireNodeChangeContents(changes);
    if (changes.parent !== undefined) {
      validateNodeParent(changes.parent, "changes.parent");
    }
    if (changes.layer !== undefined) {
      validateSceneLayer(changes.layer, "changes.layer");
    }
  }

  private requireNodeChangeContents(changes: {
    readonly properties?: NodePropertiesPatch;
    readonly visual?: NodeVisual;
    readonly text?: string;
    readonly textStyle?: TextStyle;
  }): void {
    this.requireCapability("scene");
    if (
      changes.visual !== undefined &&
      (changes.text !== undefined || changes.textStyle !== undefined)
    ) {
      throw new InvalidInputError("a node change may not combine visual and text changes");
    }
    if (changes.properties !== undefined) {
      validateNodePropertiesPatch(changes.properties, "changes.properties");
      if (changes.properties.overlapEnabled !== undefined) {
        this.requireCapability("overlap");
      }
      if (changes.properties.externalDropEnabled !== undefined) {
        this.requireCapability("external_drop");
      }
    }
    if (changes.visual !== undefined) {
      validateNodeVisual(changes.visual, "changes.visual");
      if (changes.visual.kind === "image") {
        this.requireCapability("images");
      }
    }
    if (changes.text !== undefined || changes.textStyle !== undefined) {
      this.requireCapability("text");
      if (changes.text !== undefined) {
        validateText(changes.text, "changes.text");
      }
      validateTextStyle(changes.textStyle, "changes.textStyle");
    }
  }

  private serializeSceneBatch(
    operations: readonly SceneBatchOperation[],
  ): readonly Record<string, unknown>[] {
    if (operations.length === 0) {
      throw new InvalidInputError("a scene batch requires at least one operation");
    }
    if (operations.length > MAX_SCENE_BATCH_OPERATIONS) {
      throw new InvalidInputError(
        `a scene batch may contain at most ${MAX_SCENE_BATCH_OPERATIONS} operations`,
      );
    }

    const aliases = new Set<string>();
    return operations.map((operation, index) => {
      const context = `operations[${index}]`;
      switch (operation.op) {
        case "create_node": {
          const alias = validateSceneBatchAlias(operation.alias, `${context}.alias`);
          if (aliases.has(alias)) {
            throw new InvalidInputError(`the scene batch alias ${JSON.stringify(alias)} is reused`);
          }
          const parent =
            operation.parent === undefined
              ? undefined
              : serializeBatchNodeRef(operation.parent, aliases, `${context}.parent`);
          if (parent !== undefined && operation.layer !== undefined) {
            throw new InvalidInputError(`${context} may not combine a child parent and root layer`);
          }
          this.requireNodeInput(operation.node);
          const wire: Record<string, unknown> = {
            op: "create_node",
            alias,
            node: serializeNodeInput(operation.node),
          };
          if (parent !== undefined) wire.parent = parent;
          if (operation.layer !== undefined) {
            wire.layer = validateSceneLayer(operation.layer, `${context}.layer`);
          }
          aliases.add(alias);
          return wire;
        }
        case "set_node": {
          const node = serializeBatchNodeRef(operation.node, aliases, `${context}.node`);
          this.requireSceneBatchNodeChanges(operation.changes, aliases, `${context}.changes`);
          return {
            op: "set_node",
            node,
            changes: serializeSceneBatchNodeChanges(operation.changes, aliases, context),
          };
        }
        case "remove_node":
          return {
            op: "remove_node",
            node: serializeBatchNodeRef(operation.node, aliases, `${context}.node`),
          };
        default:
          return assertNever(operation);
      }
    });
  }

  private requireSceneBatchNodeChanges(
    changes: SceneBatchNodeChanges,
    aliases: ReadonlySet<string>,
    context: string,
  ): void {
    this.requireNodeChangeContents(changes);
    if (changes.parent !== undefined) {
      const parent = validateBatchNodeParent(changes.parent, aliases, `${context}.parent`);
      if (parent.kind === "node" && changes.layer !== undefined) {
        throw new InvalidInputError(`${context} may not combine a child parent and root layer`);
      }
    }
    if (changes.layer !== undefined) {
      validateSceneLayer(changes.layer, `${context}.layer`);
    }
  }

  private requireNodePropertyCapabilities(properties: {
    readonly overlapEnabled?: boolean;
    readonly externalDropEnabled?: boolean;
  }): void {
    if (properties.overlapEnabled) {
      this.requireCapability("overlap");
    }
    if (properties.externalDropEnabled) {
      this.requireCapability("external_drop");
    }
  }

  private nextPresentationIdentifier(): PresentationId {
    const presentationId = `node-sdk-presentation-${this.nextPresentation}` as PresentationId;
    this.nextPresentation =
      this.nextPresentation === Number.MAX_SAFE_INTEGER ? 1 : this.nextPresentation + 1;
    return presentationId;
  }
}
