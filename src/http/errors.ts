// A small typed error so services can signal an HTTP status without importing
// Express. The error handler maps it to a response.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (msg: string) => new AppError(404, msg, 'not_found');
export const badRequest = (msg: string) => new AppError(400, msg, 'bad_request');
export const conflict = (msg: string) => new AppError(409, msg, 'conflict');
