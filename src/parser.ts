import { badRequest } from './errors.js';
import type { MemberKey, ParsedVcf, Variant } from './types.js';

const SNP_BASES = new Set(['A', 'C', 'G', 'T']);
const MEMBER_LABEL: Record<MemberKey, string> = {
  father: 'father',
  mother: 'mother',
  child: 'child',
};

/** 比较 (CHROM, POS, REF, ALT) 四元组：CHROM/REF/ALT 按 UTF-16 码序，POS 按数值。 */
export function compareLoci(a: Variant, b: Variant): number {
  if (a.chrom !== b.chrom) return a.chrom < b.chrom ? -1 : 1;
  if (a.pos !== b.pos) return a.pos - b.pos;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  if (a.alt !== b.alt) return a.alt < b.alt ? -1 : 1;
  return 0;
}

/**
 * 解析并严格校验一份 VCF 4.2：
 * - UTF-8、fileformat 头、唯一 #CHROM 行、恰好一个样本列
 * - 记录 1~2000 条，(CHROM,POS,REF,ALT) 严格递增
 * - 二倍体、双等位、SNP，FORMAT 固定 GT:PS，基因型完整且已定相
 */
export function parseVcf(buffer: Buffer, member: MemberKey): ParsedVcf {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw badRequest(
      'INVALID_UTF8',
      `${MEMBER_LABEL[member]} 文件不是合法的 UTF-8 文本`,
      { member },
    );
  }

  const rawLines = text.split('\n');
  // 末尾换行产生的空元素允许存在；其余空行一律拒绝。
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  let headerSeen = false;
  let fileformatSeen = false;
  let sample = '';
  const variants: Variant[] = [];

  rawLines.forEach((rawLine, lineNo0) => {
    const lineNo = lineNo0 + 1;
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.includes('\r')) {
      throw badRequest('MALFORMED_VCF', `${MEMBER_LABEL[member]} 含非法回车`, {
        member,
        line: lineNo,
      });
    }
    if (line === '') {
      throw badRequest('MALFORMED_VCF', `${MEMBER_LABEL[member]} 含空行`, {
        member,
        line: lineNo,
      });
    }

    if (!headerSeen) {
      if (lineNo === 1 && line === '##fileformat=VCFv4.2') {
        fileformatSeen = true;
        return;
      }
      if (line.startsWith('##')) return;
      if (line.startsWith('#CHROM')) {
        if (!fileformatSeen) {
          throw badRequest(
            'UNSUPPORTED_VCF_VERSION',
            `${MEMBER_LABEL[member]} 缺少 ##fileformat=VCFv4.2 首行`,
            { member },
          );
        }
        const cols = line.split('\t');
        if (
          cols.length !== 10 ||
          cols[0] !== '#CHROM' ||
          cols[1] !== 'POS' ||
          cols[2] !== 'ID' ||
          cols[3] !== 'REF' ||
          cols[4] !== 'ALT' ||
          cols[5] !== 'QUAL' ||
          cols[6] !== 'FILTER' ||
          cols[7] !== 'INFO' ||
          cols[8] !== 'FORMAT'
        ) {
          throw badRequest(
            'MALFORMED_HEADER',
            `${MEMBER_LABEL[member]} 的 #CHROM 头必须恰为 10 列（恰好一个样本）`,
            { member, line: lineNo },
          );
        }
        sample = cols[9];
        if (sample === '') {
          throw badRequest('MALFORMED_HEADER', `${MEMBER_LABEL[member]} 样本名为空`, {
            member,
          });
        }
        headerSeen = true;
        return;
      }
      throw badRequest(
        'MALFORMED_VCF',
        `${MEMBER_LABEL[member]} 头区段出现无法识别的行`,
        { member, line: lineNo },
      );
    }

    // 数据行
    const cols = line.split('\t');
    if (cols.length !== 10) {
      throw badRequest(
        'MALFORMED_RECORD',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行列数不是 10`,
        { member, line: lineNo },
      );
    }
    const [chrom, posStr, , ref, alt, , , , format, sampleData] = cols as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    if (chrom === '' || chrom.startsWith('#')) {
      throw badRequest('MALFORMED_RECORD', `${MEMBER_LABEL[member]} CHROM 非法`, {
        member,
        line: lineNo,
      });
    }
    if (!/^\d+$/.test(posStr)) {
      throw badRequest('MALFORMED_RECORD', `${MEMBER_LABEL[member]} POS 必须为正整数`, {
        member,
        line: lineNo,
      });
    }
    const pos = Number(posStr);
    if (!Number.isSafeInteger(pos) || pos < 1) {
      throw badRequest('MALFORMED_RECORD', `${MEMBER_LABEL[member]} POS 越界`, {
        member,
        line: lineNo,
      });
    }
    if (!SNP_BASES.has(ref)) {
      throw badRequest(
        'NOT_SNP',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行 REF 不是单碱基 SNP`,
        { member, line: lineNo, chrom, pos: posStr, ref },
      );
    }
    if (
      alt === '' ||
      alt.includes(',') ||
      alt === '*' ||
      alt.startsWith('<') ||
      alt.includes('[') ||
      alt.includes(']')
    ) {
      throw badRequest(
        'NOT_BIALLELIC',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行 ALT 必须是单个替换碱基`,
        { member, line: lineNo, chrom, pos: posStr, alt },
      );
    }
    if (!SNP_BASES.has(alt) || alt === ref) {
      throw badRequest(
        'NOT_SNP',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行 ALT 不是异于 REF 的单碱基 SNP`,
        { member, line: lineNo, chrom, pos: posStr, ref, alt },
      );
    }

    if (format !== 'GT:PS') {
      throw badRequest(
        'UNEXPECTED_FORMAT',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行 FORMAT 必须恰为 GT:PS`,
        { member, line: lineNo, format },
      );
    }
    const sampleFields = sampleData.split(':');
    if (sampleFields.length !== 2) {
      throw badRequest(
        'MALFORMED_GENOTYPE',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行样本字段必须为 GT:PS 两个值`,
        { member, line: lineNo },
      );
    }
    const [gt, ps] = sampleFields;
    const gtMatch = /^([01])\|([01])$/.exec(gt);
    if (!gtMatch) {
      throw badRequest(
        'UNPHASED_OR_INCOMPLETE_GENOTYPE',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行基因型必须是完整、已定相（0|0/0|1/1|0/1|1）的二倍体双等位基因型`,
        { member, line: lineNo, chrom, pos: posStr, gt },
      );
    }
    if (!/^\d+$/.test(ps)) {
      throw badRequest(
        'MALFORMED_PHASE_SET',
        `${MEMBER_LABEL[member]} 第 ${lineNo} 行 PS 必须为非负整数`,
        { member, line: lineNo, chrom, pos: posStr, ps },
      );
    }

    const variant: Variant = {
      index: variants.length,
      chrom,
      pos,
      ref,
      alt,
      alleles: [Number(gtMatch[1]) as 0 | 1, Number(gtMatch[2]) as 0 | 1],
      phased: true,
      ps,
    };

    if (variants.length > 0) {
      const prev = variants[variants.length - 1];
      if (compareLoci(prev, variant) >= 0) {
        throw badRequest(
          'LOCI_NOT_STRICTLY_INCREASING',
          `${MEMBER_LABEL[member]} 的 CHROM/POS/REF/ALT 必须严格递增`,
          {
            member,
            previous: { chrom: prev.chrom, pos: prev.pos, ref: prev.ref, alt: prev.alt },
            current: { chrom, pos, ref, alt },
          },
        );
      }
    }
    variants.push(variant);
  });

  if (!headerSeen) {
    throw badRequest('MALFORMED_HEADER', `${MEMBER_LABEL[member]} 缺少 #CHROM 头行`, {
      member,
    });
  }
  if (variants.length < 1) {
    throw badRequest('EMPTY_VCF', `${MEMBER_LABEL[member]} 至少需要 1 条记录`, { member });
  }
  if (variants.length > 2000) {
    throw badRequest(
      'TOO_MANY_RECORDS',
      `${MEMBER_LABEL[member]} 记录数 ${variants.length} 超过 2000 条上限`,
      { member, count: variants.length },
    );
  }

  return { member, sample, variants };
}
