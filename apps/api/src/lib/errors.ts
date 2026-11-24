export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, d?: Record<string, unknown>) => new AppError(400, code, msg, d);
export const unauthorized = (msg = 'Du måste logga in.', code = 'UNAUTHENTICATED') => new AppError(401, code, msg);
export const forbidden = (msg = 'Du saknar behörighet för åtgärden.', code = 'FORBIDDEN', d?: Record<string, unknown>) =>
  new AppError(403, code, msg, d);
export const notFound = (msg = 'Posten hittades inte.', code = 'NOT_FOUND') => new AppError(404, code, msg);
export const conflict = (code: string, msg: string, d?: Record<string, unknown>) => new AppError(409, code, msg, d);
