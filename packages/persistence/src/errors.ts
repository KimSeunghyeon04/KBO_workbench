export class PersistenceIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersistenceIntegrityError";
  }
}
