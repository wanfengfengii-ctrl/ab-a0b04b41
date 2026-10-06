import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { AuditError, type ReasonCode } from "./errors";
import { parseVcf, type Member } from "./parser";
import { auditTrio, type AuditReport, type SegmentResult } from "./auditor";

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

const REQUIRED_FIELDS: Member[] = ["father", "mother", "child"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 3,
    fields: 0,
  },
});

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "trio-haplotype-audit" });
  });

  const trioUpload = upload.fields([
    { name: "father", maxCount: 1 },
    { name: "mother", maxCount: 1 },
    { name: "child", maxCount: 1 },
  ]);

  app.post("/api/trios/audit", (req: Request, res: Response, next: NextFunction) => {
    trioUpload(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return reject(
              res,
              "FILE_TOO_LARGE",
              `each uploaded VCF must be at most ${MAX_FILE_BYTES} bytes (2 MiB)`,
            );
          }
          return reject(res, "INVALID_FILE", `upload rejected: ${err.message}`, undefined, 400);
        }
        return next(err);
      }
      handleAudit(req, res).catch(next);
    });
  });

  app.use((_req: Request, res: Response) => {
    reject(res, "INVALID_FILE", "not found", undefined, 404);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AuditError) {
      return reject(res, err.code, err.message, err);
    }
    return reject(res, "INVALID_FILE", err.message || "internal error", undefined, 500);
  });

  return app;
}

async function handleAudit(req: Request, res: Response): Promise<void> {
  const files = req.files as
    | Record<string, Express.Multer.File[] | undefined>
    | undefined;

  for (const name of REQUIRED_FIELDS) {
    const received = files?.[name];
    if (!received || received.length === 0) {
      return reject(res, "MISSING_FILE", `multipart field '${name}' is required`);
    }
    const file = received[0]!;
    if (file.size === 0) {
      return reject(res, "MISSING_FILE", `multipart field '${name}' is empty`, {
        member: name,
      });
    }
  }

  let report: AuditReport;
  try {
    const texts: Record<Member, string> = {
      father: decode(files!.father![0]!, "father"),
      mother: decode(files!.mother![0]!, "mother"),
      child: decode(files!.child![0]!, "child"),
    };
    const parsed = {
      father: parseVcf(texts.father, "father"),
      mother: parseVcf(texts.mother, "mother"),
      child: parseVcf(texts.child, "child"),
    };
    report = auditTrio(parsed.father, parsed.mother, parsed.child);
  } catch (err) {
    if (err instanceof AuditError) {
      return reject(res, err.code, err.message, err);
    }
    throw err;
  }

  res.json(serializeReport(report));
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decode(file: Express.Multer.File, member: Member): string {
  try {
    // VCF files are required to be UTF-8; fatal: true turns malformed bytes
    // into a structural rejection instead of silent replacement.
    return utf8Decoder.decode(file.buffer);
  } catch {
    throw new AuditError("INVALID_FILE", `${member} is not valid UTF-8`, { member });
  }
}

interface ErrorDetail {
  record?: number;
  member?: Member;
  site?: string;
}

function reject(
  res: Response,
  code: ReasonCode,
  message: string,
  detail?: ErrorDetail,
  status = 400,
): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(detail?.record !== undefined ? { record: detail.record } : {}),
      ...(detail?.member ? { member: detail.member } : {}),
      ...(detail?.site ? { site: detail.site } : {}),
    },
  });
}

interface SegmentJson {
  range: {
    start: { index: number; chrom: string; pos: number; ref: string; alt: string };
    end: { index: number; chrom: string; pos: number; ref: string; alt: string };
  };
  variantCount: number;
  verdict: "consistent" | "inconsistent";
  assignment?: SegmentResult["assignment"];
  failure?: SegmentResult["failure"];
}

function serializeReport(report: AuditReport): {
  recordCount: number;
  segmentCount: number;
  segments: SegmentJson[];
} {
  return {
    recordCount: report.recordCount,
    segmentCount: report.segments.length,
    segments: report.segments.map((s) => {
      const json: SegmentJson = {
        range: {
          start: { ...s.start },
          end: { ...s.end },
        },
        variantCount: s.variantCount,
        verdict: s.verdict,
      };
      if (s.assignment) json.assignment = s.assignment;
      if (s.failure) json.failure = s.failure;
      return json;
    }),
  };
}
