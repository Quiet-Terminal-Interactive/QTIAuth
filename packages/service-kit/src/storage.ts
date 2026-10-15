import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "@qtiauth/config";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  key: string;
  expires_at: string;
}

export class Storage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly ttlSeconds: number;

  constructor(cfg: Config["storage"]) {
    const base = {
      region: cfg.region,
      forcePathStyle: cfg.force_path_style,
      credentials: { accessKeyId: cfg.access_key_id ?? "", secretAccessKey: cfg.secret_access_key ?? "" },
    };
    this.client = new S3Client({ ...base, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}) });
    this.presignClient = new S3Client({ ...base, ...(cfg.public_endpoint ?? cfg.endpoint ? { endpoint: cfg.public_endpoint ?? cfg.endpoint } : {}) });
    this.bucket = cfg.bucket;
    this.ttlSeconds = Math.floor(cfg.presign_ttl / 1000);
  }

  static fromConfig(cfg: Config): Storage | null {
    return cfg.storage.provider === "s3" ? new Storage(cfg.storage) : null;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })).catch(() => undefined);
    }
  }

  async presignPut(key: string, contentType: string, contentLength?: number, ttlSeconds = this.ttlSeconds): Promise<PresignedUpload> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ...(contentLength ? { ContentLength: contentLength } : {}) });
    const url = await getSignedUrl(this.presignClient, cmd, { expiresIn: ttlSeconds, signableHeaders: new Set(["content-type", "content-length"]) });
    return {
      url,
      method: "PUT",
      headers: { "content-type": contentType, ...(contentLength ? { "content-length": String(contentLength) } : {}) },
      key,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async presignGet(key: string, opts: { filename?: string; attachment?: boolean; contentType?: string; ttlSeconds?: number } = {}): Promise<string> {
    const disposition = opts.attachment === false ? "inline" : `attachment${opts.filename ? `; filename="${opts.filename.replace(/["\\\r\n]/g, "_")}"` : ""}`;
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: disposition,
      ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    });
    return getSignedUrl(this.presignClient, cmd, { expiresIn: opts.ttlSeconds ?? this.ttlSeconds });
  }

  async put(key: string, body: Buffer | Uint8Array | string, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async head(key: string): Promise<{ size: number; contentType: string | undefined } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch {
      return null;
    }
  }

  async readHead(key: string, bytes: number): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((k) => ({ Key: k.key })) } }));
    }
    return keys.length;
  }
}

const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", test: (b) => b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a" },
  { type: "image/webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { type: "application/pdf", test: (b) => b.subarray(0, 5).toString() === "%PDF-" },
  { type: "application/zip", test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
];

export function sniffContentType(head: Buffer): string {
  for (const s of SIGNATURES) if (s.test(head)) return s.type;
  const sample = head.subarray(0, 512);
  let printable = 0;
  for (const byte of sample) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable++;
  if (sample.length === 0 || printable / sample.length > 0.95) {
    const text = sample.toString("utf8").trimStart().toLowerCase();
    if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<svg") || text.startsWith("<?xml")) return "text/html";
    return "text/plain";
  }
  return "application/octet-stream";
}
