import type { NextFunction, Request, Response } from 'express';

// Wraps an async route so a rejected promise reaches the error middleware
// instead of hanging the request.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
