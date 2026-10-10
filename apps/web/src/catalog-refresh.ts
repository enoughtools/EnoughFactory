interface CatalogRefreshOptions<T> {
  generation(): number;
  request(): Promise<T>;
  onValue(value: T, latestRequest: boolean): void;
  onError(cause: unknown): void;
  onSettled(): void;
}

/** A pending refresh must not hide a successful snapshot from the same device. */
export function createCatalogRefresh<T>(options: CatalogRefreshOptions<T>): () => Promise<void> {
  let started = 0;
  let applied = 0;
  return async () => {
    const generation = options.generation();
    const sequence = ++started;
    const sameConnection = () => generation === options.generation();
    const latestRequest = () => sameConnection() && sequence === started;
    try {
      const value = await options.request();
      if (sameConnection() && sequence > applied) {
        applied = sequence;
        options.onValue(value, latestRequest());
      }
    } catch (cause) {
      if (latestRequest()) options.onError(cause);
    } finally {
      if (latestRequest()) options.onSettled();
    }
  };
}
