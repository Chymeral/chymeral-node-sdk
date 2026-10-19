import type { Capability, CloseReason } from "./types.js";

/** Base class for errors raised by the Chymeral Node SDK. */
export class ClpError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A required inherited CLP environment variable was absent. */
export class MissingEnvironmentError extends ClpError {
  public readonly variable: string;

  public constructor(variable: string) {
    super(`missing inherited environment variable ${variable}`);
    this.variable = variable;
  }
}

/** The host sent malformed or unexpected CLP data. */
export class ProtocolError extends ClpError {}

/** The host rejected a non-command operation. */
export class HostError extends ClpError {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`CLP host error ${code}: ${message}`);
    this.code = code;
  }
}

/** The host rejected a scene command. */
export class CommandError extends ClpError {
  public readonly requestId: string;
  public readonly code: string;

  public constructor(requestId: string, code: string, message: string) {
    super(`CLP command ${requestId} failed with ${code}: ${message}`);
    this.requestId = requestId;
    this.code = code;
  }
}

/** An SDK operation needs a capability the host did not grant. */
export class CapabilityNotGrantedError extends ClpError {
  public readonly capability: Capability;

  public constructor(capability: Capability) {
    super(`CLP capability ${capability} was not granted`);
    this.capability = capability;
  }
}

/** A CLP operation was attempted after session closure. */
export class SessionClosedError extends ClpError {
  public readonly reason: CloseReason;

  public constructor(reason: CloseReason) {
    super(`CLP session is closed: ${reason.kind}`);
    this.reason = reason;
  }
}

/** A public SDK method received invalid local input. */
export class InvalidInputError extends ClpError {}

/** The local named-pipe or Unix-socket transport failed. */
export class TransportError extends ClpError {}
