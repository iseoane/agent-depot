/** Raised for invalid CLI usage; the message is printed verbatim. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
