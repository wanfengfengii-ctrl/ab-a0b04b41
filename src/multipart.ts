import type { IncomingMessage } from 'node:http';
import { uploadError } from './errors.js';
import type { MemberKey } from './types.js';

export interface UploadedFiles {
  files: Record<MemberKey, Buffer>;
  filenames: Record<MemberKey, string>;
}

export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB
const MAX_BODY_SIZE = 3 * MAX_FILE_SIZE + 1024 * 1024;
const MAX_PARTS = 20;

const CRLF = Buffer.from('\r\n');
const FIELD_NAMES: ReadonlySet<string> = new Set(['father', 'mother', 'child']);

/** 读取并聚合请求体，超过总体上限立即中止。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_SIZE) {
      req.destroy();
      throw uploadError(
        'PAYLOAD_TOO_LARGE',
        `请求体超过上限 ${MAX_BODY_SIZE} 字节`,
        413,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

/** 从 Content-Type 提取 boundary（RFC 2046）。 */
export function extractBoundary(contentType: string | undefined): string {
  if (!contentType) {
    throw uploadError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type 必须为 multipart/form-data 并携带 boundary',
      415,
    );
  }
  const m = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([!-~]+))/i.exec(
    contentType,
  );
  if (!m) {
    throw uploadError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type 必须为 multipart/form-data 并携带 boundary',
      415,
    );
  }
  const boundary = (m[1] ?? m[2]).trim();
  if (boundary.length === 0 || boundary.length > 70 || /[^\x21-\x7e]/.test(boundary)) {
    throw uploadError('MALFORMED_MULTIPART', 'multipart boundary 非法');
  }
  return boundary;
}

function parsePartHeaders(headerBlock: Buffer): {
  name: string;
  filename: string | null;
} {
  let name: string | null = null;
  let filename: string | null = null;
  for (const rawHeader of headerBlock.toString('latin1').split('\r\n')) {
    const colon = rawHeader.indexOf(':');
    if (colon === -1) throw uploadError('MALFORMED_MULTIPART', '部件头格式非法');
    const headerName = rawHeader.slice(0, colon).trim().toLowerCase();
    if (headerName !== 'content-disposition') continue;
    const value = rawHeader.slice(colon + 1);
    const nameMatch = /;\s*name="([^"]*)"/i.exec(value);
    const fileMatch = /;\s*filename="([^"]*)"/i.exec(value);
    if (nameMatch) name = nameMatch[1];
    if (fileMatch) filename = fileMatch[1];
  }
  if (name === null) {
    throw uploadError('MALFORMED_MULTIPART', '部件缺少 Content-Disposition 中的 name');
  }
  return { name, filename };
}

/** 严格解析 multipart/form-data，仅接受 father/mother/child 三个文件部件且各出现一次。 */
function parseMultipartBody(body: Buffer, boundary: string): UploadedFiles {
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  const files = new Map<MemberKey, Buffer>();
  const filenames = new Map<MemberKey, string>();

  let pos = body.indexOf(delim);
  if (pos !== 0) {
    throw uploadError('MALFORMED_MULTIPART', '请求体未以 multipart 边界开始');
  }
  pos += delim.length;

  let parts = 0;
  let closed = false;
  while (parts < MAX_PARTS) {
    // 边界之后："--" 表示结束，否则应为 CRLF 引出部件。
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) {
      closed = true;
      pos += 2;
      break;
    }
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) {
      throw uploadError('MALFORMED_MULTIPART', 'multipart 边界之后缺少 CRLF');
    }
    pos += 2;

    const nextDelim = body.indexOf(Buffer.concat([CRLF, delim]), pos);
    if (nextDelim === -1) {
      throw uploadError('MALFORMED_MULTIPART', '找不到 multipart 结束边界');
    }
    const part = body.subarray(pos, nextDelim);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      throw uploadError('MALFORMED_MULTIPART', '部件头不完整');
    }
    const { name, filename } = parsePartHeaders(part.subarray(0, headerEnd));
    const content = part.subarray(headerEnd + 4);

    if (!FIELD_NAMES.has(name)) {
      throw uploadError(
        'UNEXPECTED_FIELD',
        `只接受 father、mother、child 三个字段，收到未知字段 "${name}"`,
      );
    }
    const member = name as MemberKey;
    if (files.has(member)) {
      throw uploadError('DUPLICATE_FIELD', `字段 ${name} 重复出现`);
    }
    if (content.length > MAX_FILE_SIZE) {
      throw uploadError(
        'FILE_TOO_LARGE',
        `${name} 文件大小 ${content.length} 字节，超过单文件 2 MiB 上限`,
        413,
      );
    }
    files.set(member, Buffer.from(content));
    filenames.set(member, filename ?? '');

    pos = nextDelim + 2 + delim.length;
    parts += 1;
  }

  if (!closed) {
    throw uploadError('MALFORMED_MULTIPART', 'multipart 部件数量过多或缺少结束边界');
  }

  for (const required of ['father', 'mother', 'child'] as const) {
    if (!files.has(required)) {
      throw uploadError('MISSING_FILE', `缺少必需的文件字段 ${required}`);
    }
    const buf = files.get(required)!;
    if (buf.length === 0) {
      throw uploadError('EMPTY_FILE', `${required} 上传文件为空`);
    }
  }

  return {
    files: {
      father: files.get('father')!,
      mother: files.get('mother')!,
      child: files.get('child')!,
    },
    filenames: {
      father: filenames.get('father')!,
      mother: filenames.get('mother')!,
      child: filenames.get('child')!,
    },
  };
}

/** 从 HTTP 请求解析三份 VCF 上传。 */
export async function parseTrioUpload(req: IncomingMessage): Promise<UploadedFiles> {
  const boundary = extractBoundary(req.headers['content-type']);
  const body = await readBody(req);
  if (body.length === 0) {
    throw uploadError('EMPTY_BODY', '请求体为空');
  }
  return parseMultipartBody(body, boundary);
}
