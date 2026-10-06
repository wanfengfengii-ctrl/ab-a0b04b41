export type GenotypeRow = readonly [
  chrom: string,
  pos: number,
  ref: string,
  alt: string,
  gt: string,
  ps: string,
];

/** 构造一份最小合法 VCF 4.2（单样本，FORMAT GT:PS）。 */
export function buildVcf(
  sample: string,
  rows: readonly GenotypeRow[],
  opts: { format?: string; fileformat?: string; extraSample?: string } = {},
): Buffer {
  const format = opts.format ?? 'GT:PS';
  let text =
    (opts.fileformat ?? '##fileformat=VCFv4.2') +
    '\n' +
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n' +
    '##FORMAT=<ID=PS,Number=1,Type=Integer,Description="Phase set">\n';
  text += `#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t${sample}`;
  if (opts.extraSample !== undefined) text += `\t${opts.extraSample}`;
  text += '\n';
  for (const [chrom, pos, ref, alt, gt, ps] of rows) {
    text += `${chrom}\t${pos}\t.\t${ref}\t${alt}\t.\t.\t.\t${format}\t${gt}:${ps}`;
    if (opts.extraSample !== undefined) text += `\t${gt}:${ps}`;
    text += '\n';
  }
  return Buffer.from(text, 'utf8');
}

export interface MultipartFile {
  name: string;
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** 按 RFC 2046 手工编码 multipart/form-data，便于 HTTP 冒烟与测试。 */
export function encodeMultipart(files: readonly MultipartFile[], boundary = 'trio-boundary-01'): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType ?? 'text/plain'}\r\n\r\n`,
        'latin1',
      ),
    );
    parts.push(f.content);
    parts.push(Buffer.from('\r\n', 'latin1'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** 生成指定条数严格递增的 SNP 记录。 */
export function snpRows(
  n: number,
  gtFor: (i: number) => string,
  psFor: (i: number) => string | number = () => 1,
): GenotypeRow[] {
  const rows: GenotypeRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(['chr1', 100 + i, 'A', 'T', gtFor(i), String(psFor(i))]);
  }
  return rows;
}
