/** The inherited endpoint variable for the current Chymeral terminal window. */
export const ENDPOINT_ENV = "CHYMERAL_CLP_ENDPOINT";

/** The inherited authentication token variable for the current CLP session. */
export const TOKEN_ENV = "CHYMERAL_CLP_TOKEN";

/** The largest CLP frame, including its one-byte kind discriminator. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** The maximum payload carried by one binary image fragment. */
export const BINARY_FRAGMENT_BYTES = 64 * 1024;

/** The largest static RGBA8 image accepted by the Chymeral host. */
export const MAX_STATIC_IMAGE_BYTES = 64 * 1024 * 1024;

/** The largest encoded GIF accepted by the Chymeral host. */
export const MAX_GIF_BYTES = 16 * 1024 * 1024;

/** The CLP version implemented by this SDK. */
export const CLP_PROTOCOL_VERSION = { major: 2, minor: 1 } as const;

/** Maximum geometry updates accepted in one frame-presentation packet. */
export const MAX_PRESENTATION_UPDATES = 256;

/** Maximum JSON payload accepted for one frame-presentation packet. */
export const MAX_PRESENTATION_PACKET_BYTES = 64 * 1024;

/** Maximum UTF-8 byte length of a presentation identifier. */
export const MAX_PRESENTATION_ID_BYTES = 128;

/** Maximum UTF-8 byte length of an application-provided window title. */
export const MAX_WINDOW_TITLE_BYTES = 256;

/** Maximum width or height of a CLP application window icon. */
export const MAX_WINDOW_ICON_DIMENSION = 256;

/** Maximum byte length of a static RGBA8 application window icon. */
export const MAX_WINDOW_ICON_BYTES = 256 * 1024;

/** A CLP protocol version. */
export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** A feature negotiated during the CLP lifecycle handshake. */
export const ALL_CAPABILITIES = [
  "scene",
  "images",
  "input",
  "timing",
  "overlap",
  "external_drop",
  "text",
  "presentation",
  "window_metadata",
] as const;

/** A capability name accepted by CLP v2.1. */
export type Capability = (typeof ALL_CAPABILITIES)[number];

declare const sessionIdBrand: unique symbol;
declare const nodeHandleBrand: unique symbol;
declare const imageHandleBrand: unique symbol;
declare const presentationIdBrand: unique symbol;

/** An opaque Chymeral session identity. */
export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };

/** An opaque scene-node handle, valid only in its creating session. */
export type NodeHandle = string & { readonly [nodeHandleBrand]: "NodeHandle" };

/** An opaque uploaded-image handle, valid only in its creating session. */
export type ImageHandle = string & { readonly [imageHandleBrand]: "ImageHandle" };

/** A client-generated identity for an asynchronous presentation packet. */
export type PresentationId = string & { readonly [presentationIdBrand]: "PresentationId" };

/** A startup command supplied in the host initialization context. */
export interface StartupCommand {
  readonly name: string;
  readonly arguments: readonly string[];
}

/** Arguments and startup commands supplied by Chymeral during initialization. */
export interface InitContext {
  readonly arguments: readonly string[];
  readonly initialCommands: readonly StartupCommand[];
  /** Window-metadata support exposed by a CLP v2.1 host, when negotiated. */
  readonly windowMetadata?: WindowMetadataSupport;
}

/** Host-specific support for application window metadata. */
export interface WindowMetadataSupport {
  /** Whether the active window backend can apply dynamic application icons. */
  readonly iconSupported: boolean;
}

/** A partial application window-metadata update.
 *
 * Omit a property to retain its current value. Set it to `null` to clear it.
 */
export interface WindowMetadataPatch {
  readonly title?: string | null;
  readonly icon?: ImageHandle | null;
}

/** Result of a successful application window-metadata update. */
export interface WindowMetadataStatus {
  /** Whether the host can apply the selected icon on its active backend. */
  readonly iconSupported: boolean;
}

/** Immutable data negotiated before the session enters the running state. */
export interface SessionInfo {
  readonly protocolVersion: ProtocolVersion;
  readonly sessionId: SessionId;
  readonly capabilities: ReadonlySet<Capability>;
  readonly context: InitContext;
}

/** A root-node drawing layer. */
export type SceneLayer = "underlay" | "overlay";

/** An RGBA8 color. */
export type Rgba8 = readonly [number, number, number, number];

/** Full geometry and interaction state used to create a visual scene node. */
export interface NodeProperties {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible?: boolean;
  readonly clipChildren?: boolean;
  readonly zIndex?: number;
  readonly overlapEnabled?: boolean;
  readonly externalDropEnabled?: boolean;
  readonly inputPassthrough?: boolean;
}

/** Full position and interaction state used to create an intrinsic text node. */
export interface TextNodeProperties {
  readonly x: number;
  readonly y: number;
  readonly visible?: boolean;
  readonly clipChildren?: boolean;
  readonly zIndex?: number;
  readonly overlapEnabled?: boolean;
  readonly externalDropEnabled?: boolean;
  readonly inputPassthrough?: boolean;
}

/** Partial geometry and interaction changes accepted by `setNode`. */
export interface NodePropertiesPatch {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly visible?: boolean;
  readonly clipChildren?: boolean;
  readonly zIndex?: number;
  readonly overlapEnabled?: boolean;
  readonly externalDropEnabled?: boolean;
  readonly inputPassthrough?: boolean;
}

/** Geometry fields eligible for frame-paced scene presentation. */
export interface PresentationPropertiesPatch {
  readonly x?: number;
  readonly y?: number;
  /** Intrinsic text nodes cannot receive this field. */
  readonly width?: number;
  /** Intrinsic text nodes cannot receive this field. */
  readonly height?: number;
}

/** One node geometry update in an atomic presentation packet. */
export interface PresentationUpdate {
  readonly node: NodeHandle;
  readonly properties: PresentationPropertiesPatch;
}

/** The interactive shape of a static RGBA8 or animated GIF image node. */
export type ImageContactShape =
  { readonly kind: "bounds" } | { readonly kind: "alpha"; readonly threshold: number };

/** Horizontal alignment for each explicit intrinsic-text line. */
export type TextAlign = "start" | "center" | "end";

/** Font weight for an intrinsic text node. */
export type TextWeight = "normal" | "bold";

/** Optional presentation values for an intrinsic text node. */
export interface TextStyle {
  readonly font?: string;
  readonly size?: number;
  readonly lineHeight?: number;
  readonly color?: Rgba8;
  readonly weight?: TextWeight;
  readonly align?: TextAlign;
}

/** Host-computed terminal-cell bounds of an intrinsic text node. */
export interface TextMetrics {
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
}

/** The value returned after a node is created. */
export interface CreatedNode {
  readonly node: NodeHandle;
  readonly textMetrics?: TextMetrics;
}

/** A retained scene node submitted to `createNode`. */
export type NodeInput =
  | { readonly kind: "empty"; readonly properties: NodeProperties }
  | {
      readonly kind: "rectangle";
      readonly properties: NodeProperties;
      readonly color: Rgba8;
    }
  | {
      readonly kind: "image";
      readonly properties: NodeProperties;
      readonly image: ImageHandle;
      readonly opacity?: number;
      readonly contactShape?: ImageContactShape;
    }
  | {
      readonly kind: "text";
      readonly properties: TextNodeProperties;
      readonly text: string;
      readonly style?: TextStyle;
    };

/** A visual replacement accepted by `setNode`. */
export type NodeVisual =
  | { readonly kind: "empty" }
  | { readonly kind: "rectangle"; readonly color: Rgba8 }
  | {
      readonly kind: "image";
      readonly image: ImageHandle;
      readonly opacity?: number;
      readonly contactShape?: ImageContactShape;
    };

/** A parent relation accepted by `setNode`. */
export type NodeParent =
  { readonly kind: "root" } | { readonly kind: "node"; readonly node: NodeHandle };

/** An atomic partial scene-node update. */
export interface NodeChanges {
  readonly properties?: NodePropertiesPatch;
  readonly parent?: NodeParent;
  readonly layer?: SceneLayer;
  readonly visual?: NodeVisual;
  readonly text?: string;
  readonly textStyle?: TextStyle;
}

/** Optional root placement for a newly created node. */
export interface CreateNodeOptions {
  readonly parent?: NodeHandle;
  readonly layer?: SceneLayer;
}

/** Image bytes submitted to `uploadImage`. */
export type ImageUpload =
  | {
      readonly kind: "rgba8";
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8Array;
    }
  | { readonly kind: "gif"; readonly bytes: Uint8Array };

/** A requested notification subscription. */
export type Subscription = "raw_input" | "terminal" | "timing";

/** A category of continuous host notifications that was coalesced or dropped. */
export type DeliveryCategory = "raw_input" | "scene" | "terminal" | "timing";

/** A program phase reported if an application faults. */
export type ProgramPhase = "init" | "start" | "event" | "command" | "tick" | "frame";

/** A terminal reason for a CLP session closure. */
export type CloseReason =
  | { readonly kind: "client_requested" }
  | {
      readonly kind: "program_fault";
      readonly phase: ProgramPhase;
      readonly message: string;
    }
  | { readonly kind: "host_shutdown" }
  | { readonly kind: "host_overloaded" }
  | { readonly kind: "protocol_violation" }
  | { readonly kind: "transport_disconnected" };

/** A two-dimensional logical coordinate or delta. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Modifier keys accompanying an input event. */
export interface Modifiers {
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly superKey: boolean;
}

/** A logical key reported by Chymeral. */
export type Key =
  | { readonly kind: "character"; readonly value: string }
  | { readonly kind: "named"; readonly value: string }
  | { readonly kind: "dead"; readonly value?: string }
  | { readonly kind: "unidentified" };

/** Press or release state of a key. */
export type KeyState = "pressed" | "released";

/** A pointer button. */
export type PointerButton =
  | { readonly kind: "primary" }
  | { readonly kind: "secondary" }
  | { readonly kind: "middle" }
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "other"; readonly value: number };

/** Unit used by a pointer scroll delta. */
export type ScrollUnit = "line" | "pixel";

/** Chymeral window focus state. */
export type FocusState = "gained" | "lost";

/** Terminal state reported to a terminal subscriber. */
export type TerminalState = "output_available" | "exited";

/** A desktop file delivered to an opt-in scene node. */
export interface ExternalFile {
  readonly uri: string;
}

/** A scene event routed to this session. */
export type SceneEvent =
  | {
      readonly kind: "pointer_enter" | "pointer_leave" | "pointer_move";
      readonly target: NodeHandle;
      readonly position: Vec2;
      readonly modifiers: Modifiers;
    }
  | {
      readonly kind: "pointer_press" | "pointer_release";
      readonly target: NodeHandle;
      readonly button: PointerButton;
      readonly position: Vec2;
      readonly modifiers: Modifiers;
    }
  | { readonly kind: "focus_gained" | "focus_lost"; readonly target: NodeHandle }
  | {
      readonly kind: "drag_start";
      readonly source: NodeHandle;
      readonly origin: Vec2;
      readonly position: Vec2;
      readonly modifiers: Modifiers;
    }
  | {
      readonly kind: "drag_enter" | "drag_leave" | "drag_move" | "drop" | "drag_end";
      readonly source?: NodeHandle;
      readonly target?: NodeHandle;
      readonly position: Vec2;
      readonly modifiers: Modifiers;
    }
  | {
      readonly kind: "drag_cancel";
      readonly source: NodeHandle;
      readonly position: Vec2;
      readonly modifiers: Modifiers;
    }
  | {
      readonly kind: "overlap_enter" | "overlap_leave";
      readonly first: NodeHandle;
      readonly second: NodeHandle;
    }
  | {
      readonly kind: "external_drop_enter" | "external_drop_over" | "external_drop_leave";
      readonly target: NodeHandle;
      readonly position: Vec2;
    }
  | {
      readonly kind: "external_drop";
      readonly target: NodeHandle;
      readonly position: Vec2;
      readonly files: readonly ExternalFile[];
    };

/** An input, scene, terminal, or custom event from Chymeral. */
export type Event =
  | {
      readonly kind: "key";
      readonly key: Key;
      readonly text?: string;
      readonly state: KeyState;
      readonly modifiers: Modifiers;
      readonly repeat: boolean;
    }
  | { readonly kind: "pointer_move"; readonly position: Vec2; readonly modifiers: Modifiers }
  | {
      readonly kind: "pointer_press" | "pointer_release";
      readonly button: PointerButton;
      readonly position: Vec2;
      readonly modifiers: Modifiers;
    }
  | {
      readonly kind: "scroll";
      readonly position: Vec2;
      readonly delta: Vec2;
      readonly unit: ScrollUnit;
      readonly modifiers: Modifiers;
    }
  | { readonly kind: "focus"; readonly state: FocusState }
  | { readonly kind: "scene"; readonly event: SceneEvent }
  | { readonly kind: "terminal"; readonly state: TerminalState }
  | { readonly kind: "custom"; readonly name: string; readonly payload: Uint8Array };

/** Current dimensions of the Chymeral surface. */
export interface Resize {
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly scaleFactor: number;
}

/** Outcome of an asynchronous frame-presentation packet. */
export type PresentationState = "presented" | "rejected" | "superseded";

/** A coalesced host status for a client-generated presentation identifier. */
export interface PresentationStatus {
  readonly presentationId: PresentationId;
  readonly status: PresentationState;
  readonly code?: string;
  readonly message?: string;
}

/** A notification delivered after the CLP lifecycle handshake. */
export type Notification =
  | { readonly kind: "event"; readonly event: Event }
  | { readonly kind: "tick"; readonly dtNs: bigint }
  | { readonly kind: "frame"; readonly dtNs: bigint }
  | { readonly kind: "resize"; readonly resize: Resize }
  | { readonly kind: "delivery_gap"; readonly categories: readonly DeliveryCategory[] }
  | { readonly kind: "presentation_status"; readonly presentation: PresentationStatus }
  | { readonly kind: "closing"; readonly reason: CloseReason }
  | { readonly kind: "closed"; readonly reason: CloseReason };
