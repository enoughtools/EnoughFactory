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

/** The runtime adapter must positively identify a safe pre-provider retry. */
export class FactoryControllerError extends Error {
  constructor(message: string, readonly recovery: "retry" | "runtime-available" | "credentials-changed" | "provider-available" | "runtime-configured" | "controller-retry-required", options?: ErrorOptions) {
    super(message, options); this.name = "FactoryControllerError";
  }
}
