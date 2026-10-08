/** Use only for an authoritative rejection; lost acknowledgements remain unknown. */
export class FactoryOperationError extends Error {
  readonly kind: "checks-failed" | "conflict" | "stale" | "capture-failed";
  constructor(kind: FactoryOperationError["kind"], message: string) {
    super(message); this.name = "FactoryOperationError"; this.kind = kind;
  }
}

export class FactoryDecisionError extends Error {
  constructor(message: string) { super(message); this.name = "FactoryDecisionError"; }
}

/** A positively known pre-effect capacity refusal; retained work remains authoritative. */
export class FactoryCapacityError extends Error {
  readonly condition = "host-disk-space";
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "FactoryCapacityError"; }
}

/** Authoring is finished; the verifier positively reports missing evidence before integration writes. */
export class FactoryVerificationWaitError extends Error {
  readonly condition = "inspection-evidence";
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "FactoryVerificationWaitError"; }
}

/** The runtime adapter must positively identify a safe pre-provider retry. */
export class FactoryControllerError extends Error {
  constructor(message: string, readonly recovery: "retry" | "runtime-available" | "credentials-changed" | "provider-available" | "runtime-configured" | "execution-capability" | "inspection-evidence" | "host-disk-space" | "controller-retry-required", options?: ErrorOptions) {
    super(message, options); this.name = "FactoryControllerError";
  }
}
