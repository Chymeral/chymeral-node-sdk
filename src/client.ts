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
import { FramedTransport } from "./transport.js";
import {
  ALL_CAPABILITIES,
  BINARY_FRAGMENT_BYTES,
  CLP_PROTOCOL_VERSION,
  ENDPOINT_ENV,
  MAX_GIF_BYTES,
  MAX_PRESENTATION_ID_BYTES,
  MAX_PRESENTATION_PACKET_BYTES,
  MAX_PRESENTATION_UPDATES,
  MAX_STATIC_IMAGE_BYTES,
  MAX_WINDOW_TITLE_BYTES,
  TOKEN_ENV,
  type Capability,
  type CloseReason,
  type CreateNodeOptions,
  type CreatedNode,
  type DeliveryCategory,
  type Event,
  type ExternalFile,
  type ImageContactShape,
  type ImageHandle,
  type ImageUpload,
  type InitContext,
  type Key,
  type Modifiers,
  type NodeChanges,
  type NodeHandle,
  type NodeInput,
  type NodeParent,
  type NodeProperties,
  type NodePropertiesPatch,
  type NodeVisual,
  type Notification,
  type PresentationId,
  type PresentationPropertiesPatch,
  type PresentationState,
  type PresentationUpdate,
  type PointerButton,
  type ProgramPhase,
  type ProtocolVersion,
  type Resize,
  type Rgba8,
  type SceneEvent,
  type SceneLayer,
  type SessionId,
  type SessionInfo,
  type Subscription,
  type TextMetrics,
  type TextNodeProperties,
  type TextStyle,
  type Vec2,
  type WindowMetadataPatch,
  type WindowMetadataStatus,
  type WindowMetadataSupport,
} from "./types.js";

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
 * An asynchronous, dependency-free CLP v2.1 client for Node.js.
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
        // CLP v2.0 hosts predate the v2.1-only presentation and window
        // metadata capabilities and can reject either enum value before they
        // reach version negotiation. Retry once with the frozen v2.0 set.
        return Client.connectOnce(
          endpoint,
          token,
          capabilities.filter(
            (capability) => capability !== "presentation" && capability !== "window_metadata",
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
  ): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      this.ensureOpen();
      const requestId = `node-sdk-${this.nextRequest}`;
      this.nextRequest = this.nextRequest === Number.MAX_SAFE_INTEGER ? 1 : this.nextRequest + 1;
      const pending: PendingCommand = { requestId, deferred: deferred<Record<string, unknown>>() };
      this.pendingCommand = pending;
      try {
        await this.transport.sendJson({ type: "command", request_id: requestId, command });
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
    if (changes.parent !== undefined) {
      validateNodeParent(changes.parent, "changes.parent");
    }
    if (changes.layer !== undefined) {
      validateSceneLayer(changes.layer, "changes.layer");
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

function normalizeCapabilities(capabilities: Iterable<Capability>): Capability[] {
  const requested = new Set<Capability>();
  for (const capability of capabilities) {
    if (!isCapability(capability)) {
      throw new InvalidInputError(`unknown CLP capability ${String(capability)}`);
    }
    requested.add(capability);
  }
  return ALL_CAPABILITIES.filter((capability) => requested.has(capability));
}

function normalizeSubscriptions(subscriptions: Iterable<Subscription>): Subscription[] {
  const requested = new Set<Subscription>();
  for (const subscription of subscriptions) {
    if (!isSubscription(subscription)) {
      throw new InvalidInputError(`unknown CLP subscription ${String(subscription)}`);
    }
    requested.add(subscription);
  }
  const known: readonly Subscription[] = ["raw_input", "terminal", "timing"];
  return known.filter((subscription) => requested.has(subscription));
}

function serializeNodeInput(node: NodeInput): Record<string, unknown> {
  switch (node.kind) {
    case "empty":
      return { kind: "empty", properties: serializeNodeProperties(node.properties) };
    case "rectangle":
      return {
        kind: "rectangle",
        properties: serializeNodeProperties(node.properties),
        color: serializeColor(node.color, "node.color"),
      };
    case "image":
      return {
        kind: "image",
        properties: serializeNodeProperties(node.properties),
        image: validateImageHandle(node.image, "node.image"),
        opacity: normalizeOpacity(node.opacity, "node.opacity"),
        contact_shape: serializeContactShape(node.contactShape, "node.contactShape"),
      };
    case "text":
      return {
        kind: "text",
        properties: serializeTextNodeProperties(node.properties),
        text: node.text,
        style: serializeTextStyle(node.style, "node.style"),
      };
    default:
      return assertNever(node);
  }
}

function serializeNodeChanges(changes: NodeChanges): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (changes.properties !== undefined) {
    wire.properties = serializeNodePropertiesPatch(changes.properties);
  }
  if (changes.parent !== undefined) {
    wire.parent = serializeNodeParent(changes.parent);
  }
  if (changes.layer !== undefined) {
    wire.layer = validateSceneLayer(changes.layer, "changes.layer");
  }
  if (changes.visual !== undefined) {
    wire.visual = serializeNodeVisual(changes.visual);
  }
  if (changes.text !== undefined) {
    wire.text = changes.text;
  }
  if (changes.textStyle !== undefined) {
    wire.text_style = serializeTextStyle(changes.textStyle, "changes.textStyle");
  }
  return wire;
}

function serializeNodeProperties(properties: NodeProperties): Record<string, unknown> {
  validateNodeProperties(properties, "properties");
  return {
    x: properties.x,
    y: properties.y,
    width: properties.width,
    height: properties.height,
    visible: properties.visible ?? true,
    clip_children: properties.clipChildren ?? false,
    z_index: properties.zIndex ?? 0,
    overlap_enabled: properties.overlapEnabled ?? false,
    external_drop_enabled: properties.externalDropEnabled ?? false,
    input_passthrough: properties.inputPassthrough ?? false,
  };
}

function serializeTextNodeProperties(properties: TextNodeProperties): Record<string, unknown> {
  validateTextNodeProperties(properties, "properties");
  return {
    x: properties.x,
    y: properties.y,
    visible: properties.visible ?? true,
    clip_children: properties.clipChildren ?? false,
    z_index: properties.zIndex ?? 0,
    overlap_enabled: properties.overlapEnabled ?? false,
    external_drop_enabled: properties.externalDropEnabled ?? false,
    input_passthrough: properties.inputPassthrough ?? false,
  };
}

function serializeNodePropertiesPatch(properties: NodePropertiesPatch): Record<string, unknown> {
  validateNodePropertiesPatch(properties, "properties");
  const wire: Record<string, unknown> = {};
  if (properties.x !== undefined) wire.x = properties.x;
  if (properties.y !== undefined) wire.y = properties.y;
  if (properties.width !== undefined) wire.width = properties.width;
  if (properties.height !== undefined) wire.height = properties.height;
  if (properties.visible !== undefined) wire.visible = properties.visible;
  if (properties.clipChildren !== undefined) wire.clip_children = properties.clipChildren;
  if (properties.zIndex !== undefined) wire.z_index = properties.zIndex;
  if (properties.overlapEnabled !== undefined) wire.overlap_enabled = properties.overlapEnabled;
  if (properties.externalDropEnabled !== undefined) {
    wire.external_drop_enabled = properties.externalDropEnabled;
  }
  if (properties.inputPassthrough !== undefined)
    wire.input_passthrough = properties.inputPassthrough;
  return wire;
}

function serializePresentationUpdate(
  update: PresentationUpdate,
  context: string,
): Record<string, unknown> {
  return {
    node: validateNodeHandle(update.node, `${context}.node`),
    properties: serializePresentationPropertiesPatch(update.properties, `${context}.properties`),
  };
}

function serializePresentationPropertiesPatch(
  properties: PresentationPropertiesPatch,
  context: string,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (properties.x !== undefined) {
    validateFiniteNumber(properties.x, `${context}.x`);
    wire.x = properties.x;
  }
  if (properties.y !== undefined) {
    validateFiniteNumber(properties.y, `${context}.y`);
    wire.y = properties.y;
  }
  if (properties.width !== undefined) {
    validateNonNegativeFiniteNumber(properties.width, `${context}.width`);
    wire.width = properties.width;
  }
  if (properties.height !== undefined) {
    validateNonNegativeFiniteNumber(properties.height, `${context}.height`);
    wire.height = properties.height;
  }
  if (Object.keys(wire).length === 0) {
    throw new InvalidInputError(`${context} must change at least one geometry property`);
  }
  return wire;
}

function serializeNodeVisual(visual: NodeVisual): Record<string, unknown> {
  validateNodeVisual(visual, "visual");
  switch (visual.kind) {
    case "empty":
      return { kind: "empty" };
    case "rectangle":
      return { kind: "rectangle", color: serializeColor(visual.color, "visual.color") };
    case "image":
      return {
        kind: "image",
        image: validateImageHandle(visual.image, "visual.image"),
        opacity: normalizeOpacity(visual.opacity, "visual.opacity"),
        contact_shape: serializeContactShape(visual.contactShape, "visual.contactShape"),
      };
    default:
      return assertNever(visual);
  }
}

function serializeNodeParent(parent: NodeParent): Record<string, unknown> {
  validateNodeParent(parent, "parent");
  return parent.kind === "root"
    ? { kind: "root" }
    : { kind: "node", node: validateNodeHandle(parent.node, "parent.node") };
}

function serializeContactShape(
  shape: ImageContactShape | undefined,
  context: string,
): Record<string, unknown> {
  validateContactShape(shape, context);
  if (shape === undefined || shape.kind === "bounds") {
    return { kind: "bounds" };
  }
  return { kind: "alpha", threshold: shape.threshold };
}

function serializeTextStyle(
  style: TextStyle | undefined,
  context: string,
): Record<string, unknown> {
  validateTextStyle(style, context);
  const wire: Record<string, unknown> = {
    weight: style?.weight ?? "normal",
    align: style?.align ?? "start",
  };
  if (style?.font !== undefined) wire.font = style.font;
  if (style?.size !== undefined) wire.size = style.size;
  if (style?.lineHeight !== undefined) wire.line_height = style.lineHeight;
  if (style?.color !== undefined) wire.color = serializeColor(style.color, `${context}.color`);
  return wire;
}

function serializeImageUpload(image: ImageUpload): {
  readonly source: Record<string, unknown>;
  readonly bytes: Uint8Array;
} {
  switch (image.kind) {
    case "rgba8": {
      validatePositiveU32(image.width, "image.width");
      validatePositiveU32(image.height, "image.height");
      const expectedLength = image.width * image.height * 4;
      if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_STATIC_IMAGE_BYTES) {
        throw new InvalidInputError(
          `RGBA8 image data may not exceed ${MAX_STATIC_IMAGE_BYTES} bytes`,
        );
      }
      if (image.pixels.byteLength !== expectedLength) {
        throw new InvalidInputError(
          `RGBA8 image data has ${image.pixels.byteLength} bytes, expected ${expectedLength}`,
        );
      }
      return {
        source: { kind: "rgba8", width: image.width, height: image.height },
        bytes: image.pixels,
      };
    }
    case "gif":
      if (image.bytes.byteLength > MAX_GIF_BYTES) {
        throw new InvalidInputError(`encoded GIF image may not exceed ${MAX_GIF_BYTES} bytes`);
      }
      return {
        source: { kind: "gif", byte_length: image.bytes.byteLength },
        bytes: image.bytes,
      };
    default:
      return assertNever(image);
  }
}

function decodePresentationStatus(message: Record<string, unknown>): {
  readonly presentationId: PresentationId;
  readonly status: PresentationState;
  readonly code?: string;
  readonly message?: string;
} {
  const presentationId = decodePresentationId(
    message.presentation_id,
    "presentation_status.presentation_id",
  );
  const status = enumValue(
    message.status,
    ["presented", "rejected", "superseded"] as const,
    "presentation_status.status",
  );
  const code = optionalString(message.code, "presentation_status.code");
  const diagnostic = optionalString(message.message, "presentation_status.message");
  const result = { presentationId, status };
  if (code !== undefined && diagnostic !== undefined) {
    return { ...result, code, message: diagnostic };
  }
  if (code !== undefined) return { ...result, code };
  return diagnostic === undefined ? result : { ...result, message: diagnostic };
}

function decodeInitContext(value: unknown): InitContext {
  const context = record(value, "init.context");
  const windowMetadata =
    context.window_metadata === undefined
      ? undefined
      : decodeWindowMetadataSupport(context.window_metadata, "init.context.window_metadata");
  return {
    arguments: arrayField(context, "arguments", "init.context").map((argument, index) =>
      stringValue(argument, `init.context.arguments[${index}]`),
    ),
    initialCommands: arrayField(context, "initial_commands", "init.context").map(
      (command, index) => {
        const current = record(command, `init.context.initial_commands[${index}]`);
        return {
          name: stringField(current, "name", `init.context.initial_commands[${index}]`),
          arguments: arrayField(
            current,
            "arguments",
            `init.context.initial_commands[${index}]`,
          ).map((argument, argumentIndex) =>
            stringValue(
              argument,
              `init.context.initial_commands[${index}].arguments[${argumentIndex}]`,
            ),
          ),
        };
      },
    ),
    ...(windowMetadata === undefined ? {} : { windowMetadata }),
  };
}

function decodeWindowMetadataSupport(value: unknown, context: string): WindowMetadataSupport {
  const support = record(value, context);
  return { iconSupported: booleanField(support, "icon_supported", context) };
}

function decodeProtocolVersion(value: unknown, context: string): ProtocolVersion {
  const protocol = record(value, context);
  return {
    major: unsignedIntegerField(protocol, "major", context),
    minor: unsignedIntegerField(protocol, "minor", context),
  };
}

function decodeCapabilities(value: unknown, context: string): Capability[] {
  return array(value, context).map((capability, index) => {
    const name = stringValue(capability, `${context}[${index}]`);
    if (!isCapability(name)) {
      throw new ProtocolError(`${context}[${index}] contains unknown capability ${name}`);
    }
    return name;
  });
}

function decodeSubscriptions(values: readonly unknown[], context: string): Subscription[] {
  return values.map((subscription, index) => {
    const name = stringValue(subscription, `${context}[${index}]`);
    if (!isSubscription(name)) {
      throw new ProtocolError(`${context}[${index}] contains unknown subscription ${name}`);
    }
    return name;
  });
}

function decodeDeliveryCategories(values: readonly unknown[], context: string): DeliveryCategory[] {
  return values.map((category, index) => {
    const name = stringValue(category, `${context}[${index}]`);
    if (!isDeliveryCategory(name)) {
      throw new ProtocolError(`${context}[${index}] contains unknown delivery category ${name}`);
    }
    return name;
  });
}

function decodeEvent(value: unknown): Event {
  const event = record(value, "event");
  const kind = stringField(event, "kind", "event");
  switch (kind) {
    case "key": {
      const result: Event = {
        kind,
        key: decodeKey(event.key, "event.key"),
        state: enumValue(event.state, ["pressed", "released"] as const, "event.state"),
        modifiers: decodeModifiers(event.modifiers, "event.modifiers"),
        repeat: booleanField(event, "repeat", "event"),
      };
      const text = optionalString(event.text, "event.text");
      return text === undefined ? result : { ...result, text };
    }
    case "pointer_move":
      return {
        kind,
        position: decodeVec2(event.position, "event.position"),
        modifiers: decodeModifiers(event.modifiers, "event.modifiers"),
      };
    case "pointer_press":
    case "pointer_release":
      return {
        kind,
        button: decodePointerButton(event.button, "event.button"),
        position: decodeVec2(event.position, "event.position"),
        modifiers: decodeModifiers(event.modifiers, "event.modifiers"),
      };
    case "scroll":
      return {
        kind,
        position: decodeVec2(event.position, "event.position"),
        delta: decodeVec2(event.delta, "event.delta"),
        unit: enumValue(event.unit, ["line", "pixel"] as const, "event.unit"),
        modifiers: decodeModifiers(event.modifiers, "event.modifiers"),
      };
    case "focus":
      return { kind, state: enumValue(event.state, ["gained", "lost"] as const, "event.state") };
    case "scene":
      return { kind, event: decodeSceneEvent(event.event) };
    case "terminal":
      return {
        kind,
        state: enumValue(event.state, ["output_available", "exited"] as const, "event.state"),
      };
    case "custom":
      return {
        kind,
        name: stringField(event, "name", "event"),
        payload: decodeBytes(event.payload, "event.payload"),
      };
    default:
      throw new ProtocolError(`event has unknown kind ${kind}`);
  }
}

function decodeSceneEvent(value: unknown): SceneEvent {
  const event = record(value, "scene event");
  const kind = stringField(event, "kind", "scene event");
  switch (kind) {
    case "pointer_enter":
    case "pointer_leave":
    case "pointer_move":
      return {
        kind,
        target: decodeNodeHandle(event.target, "scene event.target"),
        position: decodeVec2(event.position, "scene event.position"),
        modifiers: decodeModifiers(event.modifiers, "scene event.modifiers"),
      };
    case "pointer_press":
    case "pointer_release":
      return {
        kind,
        target: decodeNodeHandle(event.target, "scene event.target"),
        button: decodePointerButton(event.button, "scene event.button"),
        position: decodeVec2(event.position, "scene event.position"),
        modifiers: decodeModifiers(event.modifiers, "scene event.modifiers"),
      };
    case "focus_gained":
    case "focus_lost":
      return { kind, target: decodeNodeHandle(event.target, "scene event.target") };
    case "drag_start":
      return {
        kind,
        source: decodeNodeHandle(event.source, "scene event.source"),
        origin: decodeVec2(event.origin, "scene event.origin"),
        position: decodeVec2(event.position, "scene event.position"),
        modifiers: decodeModifiers(event.modifiers, "scene event.modifiers"),
      };
    case "drag_enter":
    case "drag_leave":
    case "drag_move":
    case "drop":
    case "drag_end": {
      const base = {
        kind,
        position: decodeVec2(event.position, "scene event.position"),
        modifiers: decodeModifiers(event.modifiers, "scene event.modifiers"),
      } as const;
      const source = optionalNodeHandle(event.source, "scene event.source");
      const target = optionalNodeHandle(event.target, "scene event.target");
      if (source !== undefined && target !== undefined) return { ...base, source, target };
      if (source !== undefined) return { ...base, source };
      return target === undefined ? base : { ...base, target };
    }
    case "drag_cancel":
      return {
        kind,
        source: decodeNodeHandle(event.source, "scene event.source"),
        position: decodeVec2(event.position, "scene event.position"),
        modifiers: decodeModifiers(event.modifiers, "scene event.modifiers"),
      };
    case "overlap_enter":
    case "overlap_leave":
      return {
        kind,
        first: decodeNodeHandle(event.first, "scene event.first"),
        second: decodeNodeHandle(event.second, "scene event.second"),
      };
    case "external_drop_enter":
    case "external_drop_over":
    case "external_drop_leave":
      return {
        kind,
        target: decodeNodeHandle(event.target, "scene event.target"),
        position: decodeVec2(event.position, "scene event.position"),
      };
    case "external_drop":
      return {
        kind,
        target: decodeNodeHandle(event.target, "scene event.target"),
        position: decodeVec2(event.position, "scene event.position"),
        files: arrayField(event, "files", "scene event").map((file, index): ExternalFile => {
          const current = record(file, `scene event.files[${index}]`);
          return { uri: stringField(current, "uri", `scene event.files[${index}]`) };
        }),
      };
    default:
      throw new ProtocolError(`scene event has unknown kind ${kind}`);
  }
}

function decodeKey(value: unknown, context: string): Key {
  const key = record(value, context);
  const kind = stringField(key, "kind", context);
  switch (kind) {
    case "character":
    case "named":
      return { kind, value: stringField(key, "value", context) };
    case "dead": {
      const dead = optionalString(key.value, `${context}.value`);
      return dead === undefined ? { kind } : { kind, value: dead };
    }
    case "unidentified":
      return { kind };
    default:
      throw new ProtocolError(`${context} has unknown kind ${kind}`);
  }
}

function decodePointerButton(value: unknown, context: string): PointerButton {
  const button = record(value, context);
  const kind = stringField(button, "kind", context);
  if (["primary", "secondary", "middle", "back", "forward"].includes(kind)) {
    return { kind: kind as Exclude<PointerButton["kind"], "other"> };
  }
  if (kind === "other") {
    return { kind, value: unsignedIntegerField(button, "value", context) };
  }
  throw new ProtocolError(`${context} has unknown kind ${kind}`);
}

function decodeVec2(value: unknown, context: string): Vec2 {
  const vector = record(value, context);
  return {
    x: finiteNumberField(vector, "x", context),
    y: finiteNumberField(vector, "y", context),
  };
}

function decodeModifiers(value: unknown, context: string): Modifiers {
  const modifiers = record(value, context);
  return {
    shift: booleanField(modifiers, "shift", context),
    control: booleanField(modifiers, "control", context),
    alt: booleanField(modifiers, "alt", context),
    superKey: booleanField(modifiers, "super_key", context),
  };
}

function decodeResize(message: Record<string, unknown>): Resize {
  return {
    physicalWidth: unsignedIntegerField(message, "physical_width", "resize"),
    physicalHeight: unsignedIntegerField(message, "physical_height", "resize"),
    logicalWidth: finiteNumberField(message, "logical_width", "resize"),
    logicalHeight: finiteNumberField(message, "logical_height", "resize"),
    scaleFactor: finiteNumberField(message, "scale_factor", "resize"),
  };
}

function decodeCloseReason(value: unknown, context: string): CloseReason {
  const reason = record(value, context);
  const kind = stringField(reason, "kind", context);
  switch (kind) {
    case "client_requested":
    case "host_shutdown":
    case "host_overloaded":
    case "protocol_violation":
    case "transport_disconnected":
      return { kind };
    case "program_fault":
      return {
        kind,
        phase: decodeProgramPhase(reason.phase, `${context}.phase`),
        message: stringField(reason, "message", context),
      };
    default:
      throw new ProtocolError(`${context} has unknown kind ${kind}`);
  }
}

function decodeDuration(value: unknown, context: string): bigint {
  const text = stringValue(value, context);
  try {
    const duration = BigInt(text);
    if (duration < 0n) {
      throw new Error("negative duration");
    }
    return duration;
  } catch {
    throw new ProtocolError(`${context} is not a non-negative integer nanosecond duration`);
  }
}

function decodeBytes(value: unknown, context: string): Uint8Array {
  return Uint8Array.from(
    array(value, context).map((byte, index) => {
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new ProtocolError(`${context}[${index}] is not an unsigned byte`);
      }
      return byte;
    }),
  );
}

function decodeOptionalTextMetrics(value: unknown, context: string): TextMetrics | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const metrics = record(value, context);
  return {
    columns: unsignedIntegerField(metrics, "columns", context),
    rows: unsignedIntegerField(metrics, "rows", context),
    width: finiteNumberField(metrics, "width", context),
    height: finiteNumberField(metrics, "height", context),
  };
}

function decodeSessionId(value: unknown, context: string): SessionId {
  return validateHandle(stringValue(value, context), "session", context) as SessionId;
}

function decodeNodeHandle(value: unknown, context: string): NodeHandle {
  return validateHandle(stringValue(value, context), "node", context) as NodeHandle;
}

function decodeImageHandle(value: unknown, context: string): ImageHandle {
  return validateHandle(stringValue(value, context), "image", context) as ImageHandle;
}

function decodePresentationId(value: unknown, context: string): PresentationId {
  const presentationId = stringValue(value, context);
  if (
    presentationId.length === 0 ||
    Buffer.byteLength(presentationId, "utf8") > MAX_PRESENTATION_ID_BYTES
  ) {
    throw new ProtocolError(
      `${context} must contain between 1 and ${MAX_PRESENTATION_ID_BYTES} UTF-8 bytes`,
    );
  }
  return presentationId as PresentationId;
}

function optionalNodeHandle(value: unknown, context: string): NodeHandle | undefined {
  return value === undefined || value === null ? undefined : decodeNodeHandle(value, context);
}

function validateNodeHandle(value: NodeHandle, context: string): NodeHandle {
  return validateHandle(value, "node", context) as NodeHandle;
}

function validateImageHandle(value: ImageHandle, context: string): ImageHandle {
  return validateHandle(value, "image", context) as ImageHandle;
}

function serializeWindowMetadataPatch(metadata: WindowMetadataPatch): Record<string, unknown> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new InvalidInputError("metadata must be an object");
  }

  const serialized: Record<string, unknown> = { op: "set_window_metadata" };
  if (metadata.title !== undefined) {
    serialized.title =
      metadata.title === null ? null : validateWindowTitle(metadata.title, "metadata.title");
  }
  if (metadata.icon !== undefined) {
    serialized.icon =
      metadata.icon === null ? null : validateImageHandle(metadata.icon, "metadata.icon");
  }
  if (Object.keys(serialized).length === 1) {
    throw new InvalidInputError("window metadata must update a title and/or icon");
  }
  return serialized;
}

function validateWindowTitle(value: string, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_WINDOW_TITLE_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new InvalidInputError(
      `${context} must contain 1 to ${MAX_WINDOW_TITLE_BYTES} UTF-8 bytes without control characters`,
    );
  }
  return value;
}

function validatePresentationId(value: string, context: string): PresentationId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PRESENTATION_ID_BYTES
  ) {
    throw new InvalidInputError(
      `${context} must contain between 1 and ${MAX_PRESENTATION_ID_BYTES} UTF-8 bytes`,
    );
  }
  return value as PresentationId;
}

function validateHandle(value: string, kind: string, context: string): string {
  if (!new RegExp(`^${kind}-[1-9][0-9]*$`).test(value)) {
    throw new InvalidInputError(`${context} is not a valid ${kind} handle`);
  }
  return value;
}

function validateNodeProperties(properties: NodeProperties, context: string): void {
  validateFiniteNumber(properties.x, `${context}.x`);
  validateFiniteNumber(properties.y, `${context}.y`);
  validateNonNegativeFiniteNumber(properties.width, `${context}.width`);
  validateNonNegativeFiniteNumber(properties.height, `${context}.height`);
  validateOptionalBoolean(properties.visible, `${context}.visible`);
  validateOptionalBoolean(properties.clipChildren, `${context}.clipChildren`);
  validateOptionalI32(properties.zIndex, `${context}.zIndex`);
  validateOptionalBoolean(properties.overlapEnabled, `${context}.overlapEnabled`);
  validateOptionalBoolean(properties.externalDropEnabled, `${context}.externalDropEnabled`);
  validateOptionalBoolean(properties.inputPassthrough, `${context}.inputPassthrough`);
}

function validateTextNodeProperties(properties: TextNodeProperties, context: string): void {
  validateFiniteNumber(properties.x, `${context}.x`);
  validateFiniteNumber(properties.y, `${context}.y`);
  validateOptionalBoolean(properties.visible, `${context}.visible`);
  validateOptionalBoolean(properties.clipChildren, `${context}.clipChildren`);
  validateOptionalI32(properties.zIndex, `${context}.zIndex`);
  validateOptionalBoolean(properties.overlapEnabled, `${context}.overlapEnabled`);
  validateOptionalBoolean(properties.externalDropEnabled, `${context}.externalDropEnabled`);
  validateOptionalBoolean(properties.inputPassthrough, `${context}.inputPassthrough`);
}

function validateNodePropertiesPatch(properties: NodePropertiesPatch, context: string): void {
  if (properties.x !== undefined) validateFiniteNumber(properties.x, `${context}.x`);
  if (properties.y !== undefined) validateFiniteNumber(properties.y, `${context}.y`);
  if (properties.width !== undefined)
    validateNonNegativeFiniteNumber(properties.width, `${context}.width`);
  if (properties.height !== undefined)
    validateNonNegativeFiniteNumber(properties.height, `${context}.height`);
  validateOptionalBoolean(properties.visible, `${context}.visible`);
  validateOptionalBoolean(properties.clipChildren, `${context}.clipChildren`);
  validateOptionalI32(properties.zIndex, `${context}.zIndex`);
  validateOptionalBoolean(properties.overlapEnabled, `${context}.overlapEnabled`);
  validateOptionalBoolean(properties.externalDropEnabled, `${context}.externalDropEnabled`);
  validateOptionalBoolean(properties.inputPassthrough, `${context}.inputPassthrough`);
}

function validateNodeVisual(visual: NodeVisual, context: string): void {
  switch (visual.kind) {
    case "empty":
      return;
    case "rectangle":
      validateColor(visual.color, `${context}.color`);
      return;
    case "image":
      validateImageHandle(visual.image, `${context}.image`);
      validateOpacity(visual.opacity, `${context}.opacity`);
      validateContactShape(visual.contactShape, `${context}.contactShape`);
      return;
    default:
      return assertNever(visual);
  }
}

function validateNodeParent(parent: NodeParent, context: string): void {
  if (parent.kind === "root") {
    return;
  }
  if (parent.kind === "node") {
    validateNodeHandle(parent.node, `${context}.node`);
    return;
  }
  assertNever(parent);
}

function validateContactShape(shape: ImageContactShape | undefined, context: string): void {
  if (shape === undefined || shape.kind === "bounds") {
    return;
  }
  if (shape.kind !== "alpha") {
    throw new InvalidInputError(`${context} has an unknown image contact shape`);
  }
  if (!Number.isInteger(shape.threshold) || shape.threshold < 1 || shape.threshold > 255) {
    throw new InvalidInputError(`${context}.threshold must be an integer between 1 and 255`);
  }
}

function validateTextStyle(style: TextStyle | undefined, context: string): void {
  if (style === undefined) {
    return;
  }
  if (style.font !== undefined && style.font.length === 0) {
    throw new InvalidInputError(`${context}.font may not be empty`);
  }
  if (style.size !== undefined) validatePositiveFiniteNumber(style.size, `${context}.size`);
  if (style.lineHeight !== undefined) {
    validatePositiveFiniteNumber(style.lineHeight, `${context}.lineHeight`);
  }
  if (style.color !== undefined) validateColor(style.color, `${context}.color`);
  if (style.weight !== undefined && style.weight !== "normal" && style.weight !== "bold") {
    throw new InvalidInputError(`${context}.weight must be normal or bold`);
  }
  if (style.align !== undefined && !["start", "center", "end"].includes(style.align)) {
    throw new InvalidInputError(`${context}.align must be start, center, or end`);
  }
}

function validateText(text: string, context: string): void {
  if (typeof text !== "string") {
    throw new InvalidInputError(`${context} must be a string`);
  }
}

function validateColor(color: Rgba8, context: string): void {
  if (!Array.isArray(color) || color.length !== 4) {
    throw new InvalidInputError(`${context} must contain exactly four RGBA8 components`);
  }
  color.forEach((component, index) => {
    if (!Number.isInteger(component) || component < 0 || component > 255) {
      throw new InvalidInputError(`${context}[${index}] must be an integer between 0 and 255`);
    }
  });
}

function serializeColor(color: Rgba8, context: string): number[] {
  validateColor(color, context);
  return [...color];
}

function validateOpacity(value: number | undefined, context: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new InvalidInputError(`${context} must be a finite number between 0 and 1`);
  }
}

function normalizeOpacity(value: number | undefined, context: string): number {
  validateOpacity(value, context);
  return value ?? 1;
}

function validateSceneLayer(value: SceneLayer, context: string): SceneLayer {
  if (value !== "underlay" && value !== "overlay") {
    throw new InvalidInputError(`${context} must be underlay or overlay`);
  }
  return value;
}

function validateProgramPhase(value: ProgramPhase, context: string): void {
  if (!["init", "start", "event", "command", "tick", "frame"].includes(value)) {
    throw new InvalidInputError(`${context} is not a CLP program phase`);
  }
}

function decodeProgramPhase(value: unknown, context: string): ProgramPhase {
  const phase = stringValue(value, context);
  if (!["init", "start", "event", "command", "tick", "frame"].includes(phase)) {
    throw new ProtocolError(`${context} is not a CLP program phase`);
  }
  return phase as ProgramPhase;
}

function validatePositiveU32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new InvalidInputError(`${context} must be a positive unsigned 32-bit integer`);
  }
}

function validateFiniteNumber(value: number, context: string): void {
  if (!Number.isFinite(value)) {
    throw new InvalidInputError(`${context} must be a finite number`);
  }
}

function validateNonNegativeFiniteNumber(value: number, context: string): void {
  validateFiniteNumber(value, context);
  if (value < 0) {
    throw new InvalidInputError(`${context} may not be negative`);
  }
}

function validatePositiveFiniteNumber(value: number, context: string): void {
  validateFiniteNumber(value, context);
  if (value <= 0) {
    throw new InvalidInputError(`${context} must be positive`);
  }
}

function validateOptionalBoolean(value: boolean | undefined, context: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new InvalidInputError(`${context} must be a boolean`);
  }
}

function validateOptionalI32(value: number | undefined, context: string): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff)
  ) {
    throw new InvalidInputError(`${context} must be a signed 32-bit integer`);
  }
}

function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (ALL_CAPABILITIES as readonly string[]).includes(value);
}

function isSubscription(value: unknown): value is Subscription {
  return value === "raw_input" || value === "terminal" || value === "timing";
}

function isDeliveryCategory(value: unknown): value is DeliveryCategory {
  return value === "raw_input" || value === "scene" || value === "terminal" || value === "timing";
}

function messageType(message: Record<string, unknown>): string {
  return stringField(message, "type", "host message");
}

function hostError(message: Record<string, unknown>): HostError {
  return new HostError(
    stringField(message, "code", "host error"),
    stringField(message, "message", "host error"),
  );
}

function unexpectedMessage(expected: string, message: Record<string, unknown>): ProtocolError {
  let received = "an invalid message";
  try {
    received = messageType(message);
  } catch {
    // The protocol error below carries the useful expectation.
  }
  return new ProtocolError(`expected ${expected}, received ${received}`);
}

function unexpectedCommandResult(expected: string, result: Record<string, unknown>): ProtocolError {
  let received = "an invalid command result";
  try {
    received = stringField(result, "kind", "command result");
  } catch {
    // The protocol error below carries the useful expectation.
  }
  return new ProtocolError(`expected ${expected} command result, received ${received}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recordField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): Record<string, unknown> {
  return record(value[field], `${context}.${field}`);
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`${context} must be a string`);
  }
  return value;
}

function stringField(value: Record<string, unknown>, field: string, context: string): string {
  return stringValue(value[field], `${context}.${field}`);
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return stringValue(value, context);
}

function booleanField(value: Record<string, unknown>, field: string, context: string): boolean {
  if (typeof value[field] !== "boolean") {
    throw new ProtocolError(`${context}.${field} must be a boolean`);
  }
  return value[field];
}

function finiteNumberField(value: Record<string, unknown>, field: string, context: string): number {
  const number = value[field];
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new ProtocolError(`${context}.${field} must be a finite number`);
  }
  return number;
}

function unsignedIntegerField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const number = finiteNumberField(value, field, context);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new ProtocolError(`${context}.${field} must be an unsigned 32-bit integer`);
  }
  return number;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(`${context} must be an array`);
  }
  return value;
}

function arrayField(value: Record<string, unknown>, field: string, context: string): unknown[] {
  return array(value[field], `${context}.${field}`);
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  context: string,
): T[number] {
  const candidate = stringValue(value, context);
  if (!(values as readonly string[]).includes(candidate)) {
    throw new ProtocolError(`${context} has unsupported value ${candidate}`);
  }
  return candidate as T[number];
}

function assertNever(value: never): never {
  throw new InvalidInputError(`unsupported CLP value ${String(value)}`);
}
