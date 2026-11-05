/**
 * Thrown by skeleton functions whose behavior is planned but not built yet.
 * Using a dedicated error (instead of returning placeholder data) guarantees
 * that unfinished paths fail loudly rather than looking like real results.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}
