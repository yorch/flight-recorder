import { sanitizeFilename } from './form.ts';

export class MultipartError extends Error {}

export interface UploadedFile {
  field: string;
  filename: string; // already sanitised to [A-Za-z0-9._-]
  data: Buffer;
}

export interface MultipartForm {
  fields: Record<string, string>;
  files: UploadedFile[];
}

export interface MultipartLimits {
  maxFiles: number; // §16.2: 20
  maxFileBytes: number; // §16.2: 25 MB each
}

const CRLF = Buffer.from('\r\n');

/** Minimal multipart/form-data parser (§16.2 upload limits enforced). */
export function parseMultipart(body: Buffer, contentType: string, limits: MultipartLimits): MultipartForm {
  const bm = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundaryText = bm?.[1] ?? bm?.[2];
  if (!boundaryText) throw new MultipartError('missing multipart boundary');
  const boundary = Buffer.from(`--${boundaryText}`);

  const parts: Buffer[] = [];
  let pos = body.indexOf(boundary);
  if (pos === -1) throw new MultipartError('multipart boundary not found');
  pos += boundary.length;
  for (let guard = 0; guard < 10_000; guard++) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing '--'
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const next = body.indexOf(boundary, pos);
    if (next === -1) throw new MultipartError('unterminated multipart part');
    const end = body.subarray(next - 2, next).equals(CRLF) ? next - 2 : next;
    parts.push(body.subarray(pos, end));
    pos = next + boundary.length;
  }

  const out: MultipartForm = { fields: {}, files: [] };
  for (const part of parts) {
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) throw new MultipartError('malformed multipart part');
    const headers = part.subarray(0, sep).toString('latin1');
    const content = part.subarray(sep + 4);
    const cd = /content-disposition:\s*form-data\b/i.exec(headers);
    if (!cd) continue;
    const name = /(?:^|;|\s)name="([^"]*)"/i.exec(cd.input ?? '')?.[1];
    if (name === undefined) continue;
    const filename = /(?:^|;|\s)filename="([^"]*)"/i.exec(cd.input ?? '')?.[1];
    if (filename === undefined) {
      out.fields[name] = content.toString('utf8');
      continue;
    }
    const clean = sanitizeFilename(filename);
    if (!clean) throw new MultipartError(`unusable upload filename '${filename}'`);
    if (out.files.length >= limits.maxFiles) throw new MultipartError(`too many files (max ${limits.maxFiles})`);
    if (content.length > limits.maxFileBytes) throw new MultipartError(`file '${clean}' exceeds ${limits.maxFileBytes} bytes`);
    out.files.push({ field: name, filename: clean, data: content });
  }
  return out;
}
