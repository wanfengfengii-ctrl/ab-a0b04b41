/**
 * 统一的可识别错误：携带稳定原因码与 HTTP 状态码。
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 文件结构 / VCF 内容问题（整体拒绝，400）。 */
export function badRequest(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(code, message, 400, details);
}

/** multipart 上传层面的问题（文件缺失、过大等，400/413）。 */
export function uploadError(
  code: string,
  message: string,
  status = 400,
): ApiError {
  return new ApiError(code, message, status);
}
