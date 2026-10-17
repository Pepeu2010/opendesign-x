export class PackagedPathAccessError extends Error {
  readonly title: string;

  constructor(message: string, options?: { cause?: unknown; title?: string }) {
    super(message, options);
    this.name = "PackagedPathAccessError";
    this.title = options?.title ?? "OpenDesign X cannot access its data folder";
  }
}
