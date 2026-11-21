// FROZEN class shape (Wave 0). parseLedgerError is implemented in Task 5.
export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly raw: unknown,
    public readonly retryable: boolean = false,
    public readonly errorId?: string,
    public readonly category?: string,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

export function parseLedgerError(status: number, body: unknown): LedgerError {
  void status; void body
  throw new Error('parseLedgerError: not implemented (Task 5)')
}
