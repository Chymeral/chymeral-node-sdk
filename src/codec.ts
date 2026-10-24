/**
 * Private CLP JSON codec and input-validation helpers.
 *
 * The public Client orchestrates lifecycle and command ordering. Keeping wire
 * shape validation here makes protocol changes reviewable without widening the
 * package export surface.
 */
import {
  CapabilityNotGrantedError,
  CommandError,
  HostError,
  InvalidInputError,
  MissingEnvironmentError,
  ProtocolError,
  SessionClosedError,
} from "./errors.js";
import {
  ALL_CAPABILITIES,
  BINARY_FRAGMENT_BYTES,
  CLP_PROTOCOL_VERSION,
  ENDPOINT_ENV,
  MAX_GIF_BYTES,
  MAX_PRESENTATION_ID_BYTES,
  MAX_PRESENTATION_PACKET_BYTES,
  MAX_PRESENTATION_UPDATES,
  MAX_SCENE_BATCH_ALIAS_BYTES,
  MAX_SCENE_BATCH_BYTES,
  MAX_SCENE_BATCH_OPERATIONS,
  MAX_STATIC_IMAGE_BYTES,
  MAX_WINDOW_TITLE_BYTES,
  TOKEN_ENV,
  type Capability,
  type BatchNodeParent,
  type BatchNodeRef,
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
  type SceneBatchNodeChanges,
  type SceneBatchOperation,
  type SceneBatchOperationResult,
  type SceneBatchResult,
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

export function normalizeCapabilities(capabilities: Iterable<Capability>): Capability[] {
  const requested = new Set<Capability>();
  for (const capability of capabilities) {
    if (!isCapability(capability)) {
      throw new InvalidInputError(`unknown CLP capability ${String(capability)}`);
    }
    requested.add(capability);
  }
  return ALL_CAPABILITIES.filter((capability) => requested.has(capability));
}

export function normalizeSubscriptions(subscriptions: Iterable<Subscription>): Subscription[] {
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

export function serializeNodeInput(node: NodeInput): Record<string, unknown> {
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

export function serializeNodeChanges(changes: NodeChanges): Record<string, unknown> {
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

export function serializeSceneBatchNodeChanges(
  changes: SceneBatchNodeChanges,
  aliases: ReadonlySet<string>,
  context: string,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (changes.properties !== undefined) {
    wire.properties = serializeNodePropertiesPatch(changes.properties);
  }
  if (changes.parent !== undefined) {
    wire.parent = serializeBatchNodeParent(changes.parent, aliases, `${context}.changes.parent`);
  }
  if (changes.layer !== undefined) {
    wire.layer = validateSceneLayer(changes.layer, `${context}.changes.layer`);
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

export function serializeBatchNodeRef(
  reference: BatchNodeRef,
  aliases: ReadonlySet<string>,
  context: string,
): string | Record<string, string> {
  if (typeof reference === "string") {
    return validateNodeHandle(reference as NodeHandle, context);
  }
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
    throw new InvalidInputError(`${context} must be a node handle or batch alias`);
  }
  const alias = validateSceneBatchAlias(reference.alias, `${context}.alias`);
  if (!aliases.has(alias)) {
    throw new InvalidInputError(
      `${context} refers to batch alias ${JSON.stringify(alias)} too early`,
    );
  }
  return { alias };
}

export function validateBatchNodeParent(
  parent: BatchNodeParent,
  aliases: ReadonlySet<string>,
  context: string,
): BatchNodeParent {
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    throw new InvalidInputError(`${context} must be a root or node parent`);
  }
  if (parent.kind === "root") {
    return parent;
  }
  if (parent.kind === "node") {
    serializeBatchNodeRef(parent.node, aliases, `${context}.node`);
    return parent;
  }
  throw new InvalidInputError(`${context} has an unknown parent kind`);
}

export function serializeBatchNodeParent(
  parent: BatchNodeParent,
  aliases: ReadonlySet<string>,
  context: string,
): Record<string, unknown> {
  const validated = validateBatchNodeParent(parent, aliases, context);
  if (validated.kind === "root") {
    return { kind: "root" };
  }
  return {
    kind: "node",
    node: serializeBatchNodeRef(validated.node, aliases, `${context}.node`),
  };
}

export function validateSceneBatchAlias(value: string, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SCENE_BATCH_ALIAS_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new InvalidInputError(
      `${context} must contain 1 to ${MAX_SCENE_BATCH_ALIAS_BYTES} UTF-8 bytes without control characters`,
    );
  }
  return value;
}

export function serializeNodeProperties(properties: NodeProperties): Record<string, unknown> {
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

export function serializeTextNodeProperties(
  properties: TextNodeProperties,
): Record<string, unknown> {
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

export function serializeNodePropertiesPatch(
  properties: NodePropertiesPatch,
): Record<string, unknown> {
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

export function serializePresentationUpdate(
  update: PresentationUpdate,
  context: string,
): Record<string, unknown> {
  return {
    node: validateNodeHandle(update.node, `${context}.node`),
    properties: serializePresentationPropertiesPatch(update.properties, `${context}.properties`),
  };
}

export function serializePresentationPropertiesPatch(
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

export function serializeNodeVisual(visual: NodeVisual): Record<string, unknown> {
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

export function serializeNodeParent(parent: NodeParent): Record<string, unknown> {
  validateNodeParent(parent, "parent");
  return parent.kind === "root"
    ? { kind: "root" }
    : { kind: "node", node: validateNodeHandle(parent.node, "parent.node") };
}

export function serializeContactShape(
  shape: ImageContactShape | undefined,
  context: string,
): Record<string, unknown> {
  validateContactShape(shape, context);
  if (shape === undefined || shape.kind === "bounds") {
    return { kind: "bounds" };
  }
  return { kind: "alpha", threshold: shape.threshold };
}

export function serializeTextStyle(
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

export function serializeImageUpload(image: ImageUpload): {
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

export function decodePresentationStatus(message: Record<string, unknown>): {
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

export function decodeInitContext(value: unknown): InitContext {
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

export function decodeWindowMetadataSupport(
  value: unknown,
  context: string,
): WindowMetadataSupport {
  const support = record(value, context);
  return { iconSupported: booleanField(support, "icon_supported", context) };
}

export function decodeProtocolVersion(value: unknown, context: string): ProtocolVersion {
  const protocol = record(value, context);
  return {
    major: unsignedIntegerField(protocol, "major", context),
    minor: unsignedIntegerField(protocol, "minor", context),
  };
}

export function decodeCapabilities(value: unknown, context: string): Capability[] {
  return array(value, context).map((capability, index) => {
    const name = stringValue(capability, `${context}[${index}]`);
    if (!isCapability(name)) {
      throw new ProtocolError(`${context}[${index}] contains unknown capability ${name}`);
    }
    return name;
  });
}

export function decodeSubscriptions(values: readonly unknown[], context: string): Subscription[] {
  return values.map((subscription, index) => {
    const name = stringValue(subscription, `${context}[${index}]`);
    if (!isSubscription(name)) {
      throw new ProtocolError(`${context}[${index}] contains unknown subscription ${name}`);
    }
    return name;
  });
}

export function decodeDeliveryCategories(
  values: readonly unknown[],
  context: string,
): DeliveryCategory[] {
  return values.map((category, index) => {
    const name = stringValue(category, `${context}[${index}]`);
    if (!isDeliveryCategory(name)) {
      throw new ProtocolError(`${context}[${index}] contains unknown delivery category ${name}`);
    }
    return name;
  });
}

export function decodeEvent(value: unknown): Event {
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

export function decodeSceneEvent(value: unknown): SceneEvent {
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

export function decodeKey(value: unknown, context: string): Key {
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

export function decodePointerButton(value: unknown, context: string): PointerButton {
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

export function decodeVec2(value: unknown, context: string): Vec2 {
  const vector = record(value, context);
  return {
    x: finiteNumberField(vector, "x", context),
    y: finiteNumberField(vector, "y", context),
  };
}

export function decodeModifiers(value: unknown, context: string): Modifiers {
  const modifiers = record(value, context);
  return {
    shift: booleanField(modifiers, "shift", context),
    control: booleanField(modifiers, "control", context),
    alt: booleanField(modifiers, "alt", context),
    superKey: booleanField(modifiers, "super_key", context),
  };
}

export function decodeResize(message: Record<string, unknown>): Resize {
  return {
    physicalWidth: unsignedIntegerField(message, "physical_width", "resize"),
    physicalHeight: unsignedIntegerField(message, "physical_height", "resize"),
    logicalWidth: finiteNumberField(message, "logical_width", "resize"),
    logicalHeight: finiteNumberField(message, "logical_height", "resize"),
    scaleFactor: finiteNumberField(message, "scale_factor", "resize"),
  };
}

export function decodeCloseReason(value: unknown, context: string): CloseReason {
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

export function decodeDuration(value: unknown, context: string): bigint {
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

export function decodeBytes(value: unknown, context: string): Uint8Array {
  return Uint8Array.from(
    array(value, context).map((byte, index) => {
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new ProtocolError(`${context}[${index}] is not an unsigned byte`);
      }
      return byte;
    }),
  );
}

export function decodeSceneBatchResult(result: Record<string, unknown>): SceneBatchResult {
  const nodes: Record<string, CreatedNode> = {};
  for (const [alias, value] of Object.entries(recordField(result, "nodes", "command result"))) {
    const checkedAlias = decodeSceneBatchAlias(
      alias,
      `command result.nodes key ${JSON.stringify(alias)}`,
    );
    Object.defineProperty(nodes, checkedAlias, {
      configurable: true,
      enumerable: true,
      value: decodeCreatedNode(value, `command result.nodes.${JSON.stringify(alias)}`),
      writable: true,
    });
  }
  return {
    nodes,
    operations: arrayField(result, "operations", "command result").map((operation, index) =>
      decodeSceneBatchOperationResult(operation, `command result.operations[${index}]`),
    ),
  };
}

export function decodeSceneBatchOperationResult(
  value: unknown,
  context: string,
): SceneBatchOperationResult {
  const result = record(value, context);
  switch (stringField(result, "kind", context)) {
    case "created":
      return { kind: "created", alias: decodeSceneBatchAlias(result.alias, `${context}.alias`) };
    case "updated": {
      const textMetrics = decodeOptionalTextMetrics(result.text_metrics, `${context}.text_metrics`);
      return textMetrics === undefined ? { kind: "updated" } : { kind: "updated", textMetrics };
    }
    case "removed":
      return { kind: "removed" };
    default:
      throw new ProtocolError(`${context} has an unknown scene batch outcome`);
  }
}

export function decodeCreatedNode(value: unknown, context: string): CreatedNode {
  const created = record(value, context);
  const node: CreatedNode = {
    node: decodeNodeHandle(created.node, `${context}.node`),
  };
  const textMetrics = decodeOptionalTextMetrics(created.text_metrics, `${context}.text_metrics`);
  return textMetrics === undefined ? node : { ...node, textMetrics };
}

export function decodeSceneBatchAlias(value: unknown, context: string): string {
  const alias = stringValue(value, context);
  if (
    alias.length === 0 ||
    Buffer.byteLength(alias, "utf8") > MAX_SCENE_BATCH_ALIAS_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(alias)
  ) {
    throw new ProtocolError(
      `${context} must contain 1 to ${MAX_SCENE_BATCH_ALIAS_BYTES} UTF-8 bytes without control characters`,
    );
  }
  return alias;
}

export function decodeOptionalTextMetrics(
  value: unknown,
  context: string,
): TextMetrics | undefined {
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

export function decodeSessionId(value: unknown, context: string): SessionId {
  return validateHandle(stringValue(value, context), "session", context) as SessionId;
}

export function decodeNodeHandle(value: unknown, context: string): NodeHandle {
  return validateHandle(stringValue(value, context), "node", context) as NodeHandle;
}

export function decodeImageHandle(value: unknown, context: string): ImageHandle {
  return validateHandle(stringValue(value, context), "image", context) as ImageHandle;
}

export function decodePresentationId(value: unknown, context: string): PresentationId {
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

export function optionalNodeHandle(value: unknown, context: string): NodeHandle | undefined {
  return value === undefined || value === null ? undefined : decodeNodeHandle(value, context);
}

export function validateNodeHandle(value: NodeHandle, context: string): NodeHandle {
  return validateHandle(value, "node", context) as NodeHandle;
}

export function validateImageHandle(value: ImageHandle, context: string): ImageHandle {
  return validateHandle(value, "image", context) as ImageHandle;
}

export function serializeWindowMetadataPatch(
  metadata: WindowMetadataPatch,
): Record<string, unknown> {
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

export function validateWindowTitle(value: string, context: string): string {
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

export function validatePresentationId(value: string, context: string): PresentationId {
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

export function validateHandle(value: string, kind: string, context: string): string {
  if (!new RegExp(`^${kind}-[1-9][0-9]*$`).test(value)) {
    throw new InvalidInputError(`${context} is not a valid ${kind} handle`);
  }
  return value;
}

export function validateNodeProperties(properties: NodeProperties, context: string): void {
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

export function validateTextNodeProperties(properties: TextNodeProperties, context: string): void {
  validateFiniteNumber(properties.x, `${context}.x`);
  validateFiniteNumber(properties.y, `${context}.y`);
  validateOptionalBoolean(properties.visible, `${context}.visible`);
  validateOptionalBoolean(properties.clipChildren, `${context}.clipChildren`);
  validateOptionalI32(properties.zIndex, `${context}.zIndex`);
  validateOptionalBoolean(properties.overlapEnabled, `${context}.overlapEnabled`);
  validateOptionalBoolean(properties.externalDropEnabled, `${context}.externalDropEnabled`);
  validateOptionalBoolean(properties.inputPassthrough, `${context}.inputPassthrough`);
}

export function validateNodePropertiesPatch(
  properties: NodePropertiesPatch,
  context: string,
): void {
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

export function validateNodeVisual(visual: NodeVisual, context: string): void {
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

export function validateNodeParent(parent: NodeParent, context: string): void {
  if (parent.kind === "root") {
    return;
  }
  if (parent.kind === "node") {
    validateNodeHandle(parent.node, `${context}.node`);
    return;
  }
  assertNever(parent);
}

export function validateContactShape(shape: ImageContactShape | undefined, context: string): void {
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

export function validateTextStyle(style: TextStyle | undefined, context: string): void {
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

export function validateText(text: string, context: string): void {
  if (typeof text !== "string") {
    throw new InvalidInputError(`${context} must be a string`);
  }
}

export function validateColor(color: Rgba8, context: string): void {
  if (!Array.isArray(color) || color.length !== 4) {
    throw new InvalidInputError(`${context} must contain exactly four RGBA8 components`);
  }
  color.forEach((component, index) => {
    if (!Number.isInteger(component) || component < 0 || component > 255) {
      throw new InvalidInputError(`${context}[${index}] must be an integer between 0 and 255`);
    }
  });
}

export function serializeColor(color: Rgba8, context: string): number[] {
  validateColor(color, context);
  return [...color];
}

export function validateOpacity(value: number | undefined, context: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new InvalidInputError(`${context} must be a finite number between 0 and 1`);
  }
}

export function normalizeOpacity(value: number | undefined, context: string): number {
  validateOpacity(value, context);
  return value ?? 1;
}

export function validateSceneLayer(value: SceneLayer, context: string): SceneLayer {
  if (value !== "underlay" && value !== "overlay") {
    throw new InvalidInputError(`${context} must be underlay or overlay`);
  }
  return value;
}

export function validateProgramPhase(value: ProgramPhase, context: string): void {
  if (!["init", "start", "event", "command", "tick", "frame"].includes(value)) {
    throw new InvalidInputError(`${context} is not a CLP program phase`);
  }
}

export function decodeProgramPhase(value: unknown, context: string): ProgramPhase {
  const phase = stringValue(value, context);
  if (!["init", "start", "event", "command", "tick", "frame"].includes(phase)) {
    throw new ProtocolError(`${context} is not a CLP program phase`);
  }
  return phase as ProgramPhase;
}

export function validatePositiveU32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new InvalidInputError(`${context} must be a positive unsigned 32-bit integer`);
  }
}

export function validateFiniteNumber(value: number, context: string): void {
  if (!Number.isFinite(value)) {
    throw new InvalidInputError(`${context} must be a finite number`);
  }
}

export function validateNonNegativeFiniteNumber(value: number, context: string): void {
  validateFiniteNumber(value, context);
  if (value < 0) {
    throw new InvalidInputError(`${context} may not be negative`);
  }
}

export function validatePositiveFiniteNumber(value: number, context: string): void {
  validateFiniteNumber(value, context);
  if (value <= 0) {
    throw new InvalidInputError(`${context} must be positive`);
  }
}

export function validateOptionalBoolean(value: boolean | undefined, context: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new InvalidInputError(`${context} must be a boolean`);
  }
}

export function validateOptionalI32(value: number | undefined, context: string): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff)
  ) {
    throw new InvalidInputError(`${context} must be a signed 32-bit integer`);
  }
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (ALL_CAPABILITIES as readonly string[]).includes(value);
}

export function isSubscription(value: unknown): value is Subscription {
  return value === "raw_input" || value === "terminal" || value === "timing";
}

export function isDeliveryCategory(value: unknown): value is DeliveryCategory {
  return value === "raw_input" || value === "scene" || value === "terminal" || value === "timing";
}

export function messageType(message: Record<string, unknown>): string {
  return stringField(message, "type", "host message");
}

export function hostError(message: Record<string, unknown>): HostError {
  return new HostError(
    stringField(message, "code", "host error"),
    stringField(message, "message", "host error"),
  );
}

export function unexpectedMessage(
  expected: string,
  message: Record<string, unknown>,
): ProtocolError {
  let received = "an invalid message";
  try {
    received = messageType(message);
  } catch {
    // The protocol error below carries the useful expectation.
  }
  return new ProtocolError(`expected ${expected}, received ${received}`);
}

export function unexpectedCommandResult(
  expected: string,
  result: Record<string, unknown>,
): ProtocolError {
  let received = "an invalid command result";
  try {
    received = stringField(result, "kind", "command result");
  } catch {
    // The protocol error below carries the useful expectation.
  }
  return new ProtocolError(`expected ${expected} command result, received ${received}`);
}

export function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function recordField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): Record<string, unknown> {
  return record(value[field], `${context}.${field}`);
}

export function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`${context} must be a string`);
  }
  return value;
}

export function stringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  return stringValue(value[field], `${context}.${field}`);
}

export function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return stringValue(value, context);
}

export function booleanField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  if (typeof value[field] !== "boolean") {
    throw new ProtocolError(`${context}.${field} must be a boolean`);
  }
  return value[field];
}

export function finiteNumberField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const number = value[field];
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new ProtocolError(`${context}.${field} must be a finite number`);
  }
  return number;
}

export function unsignedIntegerField(
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

export function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(`${context} must be an array`);
  }
  return value;
}

export function arrayField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): unknown[] {
  return array(value[field], `${context}.${field}`);
}

export function enumValue<T extends readonly string[]>(
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

export function assertNever(value: never): never {
  throw new InvalidInputError(`unsupported CLP value ${String(value)}`);
}
