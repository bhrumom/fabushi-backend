export class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function asApiError(error, fallbackMessage = '服务器内部错误') {
  if (error instanceof ApiError) return error;
  return new ApiError(error?.message || fallbackMessage, error?.status || 500);
}
