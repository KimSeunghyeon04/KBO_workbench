export class StaleStagingDocumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaleStagingDocumentError";
  }
}

export class WorkspaceMigrationRequiredError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceMigrationRequiredError";
  }
}

export class WorkspacePersistenceBlockedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspacePersistenceBlockedError";
  }
}
