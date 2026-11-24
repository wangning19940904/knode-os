/**
 * Numbers as answers and source lines write them (docs/design/38 §4): the
 * deterministic half of "the value in the answer is the value on the cited
 * line". Thousands separators, a magnitude word after the number (万, 亿,
 * million, bn), a table's declared scale ("单位：万元", "in thousands"),
 * parentheses for a negative, and the precision a figure was rounded to are
 * all read here, without a model.
 *
 * A comparison is between absolute values: a line's "(1,234)" and an answer's
 * "-1,234" are one figure, and a sign is not what a wrong citation gets wrong.
 */

export interface NumberToken {
  /** The text as written, magnitude word included. */
  raw: string;
  /** The digits' value, separators removed (no magnitude applied). */
  mantissa: number;
  /** The magnitude word's factor (1 when none). */
  magnitude: number;
  /** Whether a magnitude word was written beside it. */
  scaled: boolean;
  /** Digits after the decimal point, for the rounding tolerance. */
  decimals: number;
  /** The unit after it, when one of the known ones is (元, %, 人 …). */
  unit: string | null;
  /** It reads as a year, a date part or an ordinal, not a measure. */
  dateLike: boolean;
  index: number;
}

const MAGNITUDES: [RegExp, number][] = [
  [/^\s*万亿/, 1e12],
  [/^\s*千亿/, 1e11],
  [/^\s*百亿/, 1e10],
  [/^\s*千万/, 1e7],
  [/^\s*百万/, 1e6],
  [/^\s*亿/, 1e8],
  [/^\s*万/, 1e4],
  [/^\s*千(?!克|米|瓦)/, 1e3],
  [/^\s*trillion\b/i, 1e12],
  [/^\s*billion\b/i, 1e9],
  [/^\s*million\b/i, 1e6],
  [/^\s*thousand\b/i, 1e3],
  [/^\s*(?:bn|b)\b/i, 1e9],
  [/^\s*(?:mn|mm|m)\b/i, 1e6],
  [/^\s*k\b/i, 1e3],
];

const UNIT = /^\s*(%|％|元|美元|港元|人民币|股|人|个|家|天|次|台|件|户|吨|小时|ms|毫秒|秒|USD|RMB|CNY|HKD|dollars?)/i;

// a number: thousands groups (comma or full-width comma; never a space, which separates a text table's columns), a decimal part
const NUMBER = /(?<![\w.])[-−+]?\(?\$?(\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\)?/g;

/** Every number in `text`, with what is written right after it. */
export function numbersIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const t = text.normalize('NFKC');
  for (const m of t.matchAll(NUMBER)) {
    const digits = m[1];
    const mantissa = Number(digits.replace(/[,，]/g, ''));
    if (!Number.isFinite(mantissa)) continue;
    const at = m.index ?? 0;
    const after = t.slice(at + m[0].length, at + m[0].length + 16);
    let magnitude = 1;
    let scaled = false;
    let rest = after;
    for (const [re, f] of MAGNITUDES) {
      const mm = re.exec(after);
      if (mm) {
        magnitude = f;
        scaled = true;
        rest = after.slice(mm[0].length);
        break;
      }
    }
    const unitM = UNIT.exec(rest);
    const unit = unitM ? normalizeUnit(unitM[1]) : null;
    const before = t.slice(Math.max(0, at - 8), at);
    const yearish = /^(19|20)\d{2}$/.test(digits);
    const dateLike = !scaled && !unit && (
      /^\s*(年|月|日|号|季度|周)/.test(after)
      || /^[-/.]\d/.test(after)
      || /\d[-/]$/.test(before)
      || /(第|W|Q|FY|H)$/i.test(before)
      || (yearish && (/^\s*(Q[1-4]|H[12]|财年|年度|fiscal)/i.test(after) || /\b(in|of|for|year|fiscal|since|until|FY)\s*$/i.test(before)))
    );
    out.push({
      raw: `${m[0]}${scaled ? after.slice(0, after.length - rest.length) : ''}`.trim(),
      mantissa,
      magnitude,
      scaled,
      decimals: digits.includes('.') ? digits.split('.')[1].length : 0,
      unit,
      dateLike,
      index: at,
    });
  }
  return out;
}

function normalizeUnit(u: string): string {
  const l = u.toLowerCase();
  if (l === '％') return '%';
  if (/^dollars?$/.test(l) || l === 'usd') return '美元';
  if (l === 'rmb' || l === 'cny' || l === '人民币') return '元';
  if (l === 'hkd') return '港元';
  return u;
}

/** The figures an answer states: its numbers that are not dates, in order. */
export function answerFigures(text: string): NumberToken[] {
  return numbersIn(text).filter((n) => !n.dateLike);
}

/**
 * The scale a table or a statement declares for its bare figures, from the
 * nearest declaration at or above `line` (0-based) within `window` lines:
 * "单位：万元", "金额单位：人民币百万元", "(in thousands, except per share data)".
 * 1 when none is found.
 */
export function declaredScale(lines: readonly string[], line: number, window = 200): number {
  return scaleDeclaration(lines, line, window)?.scale ?? 1;
}

/** The declaration `declaredScale` reads, with its words ("单位：万元", "in thousands") and its line (0-based); null when none. */
export function scaleDeclaration(lines: readonly string[], line: number, window = 200): { scale: number; words: string; line: number } | null {
  for (let i = line; i >= 0 && i >= line - window; i--) {
    const s = lines[i];
    if (!s) continue;
    const zh = /单位\s*[:：]?\s*(?:人民币|美元|港元)?\s*(万亿|千亿|百亿|千万|百万|亿|万|千)?\s*元/.exec(s) ?? /(?:人民币|美元|港元)\s*(千万|百万|亿|万|千)元/.exec(s);
    if (zh) return { scale: zh[1] ? ZH_SCALE[zh[1]] : 1, words: zh[0].trim(), line: i };
    const en = /\bin\s+(thousands|millions|billions)\b/i.exec(s) ?? /\(\s*(?:\$|USD)?\s*(thousands|millions|billions)\b/i.exec(s);
    if (en) return { scale: EN_SCALE[en[1].toLowerCase()], words: en[0].replace(/^\(\s*/, '').trim(), line: i };
  }
  return null;
}

const ZH_SCALE: Record<string, number> = { 万亿: 1e12, 千亿: 1e11, 百亿: 1e10, 千万: 1e7, 百万: 1e6, 亿: 1e8, 万: 1e4, 千: 1e3 };
const EN_SCALE: Record<string, number> = { thousands: 1e3, millions: 1e6, billions: 1e9 };

/** Half a unit in the last place written, at the token's magnitude: the error its rounding allows. */
function tolerance(n: Pick<NumberToken, 'decimals' | 'magnitude'>, scale = 1): number {
  return 0.5 * 10 ** -n.decimals * n.magnitude * scale;
}

export interface FigureMatch {
  /** The line's token that matched. */
  token: NumberToken;
  /** The scale the line's figure was read at (its own magnitude word, the table's declaration, or 1). */
  scale: number;
  /** How: `exact` at the written or declared scale, `scale-guess` only at a power of ten nothing on the page declares. */
  how: 'exact' | 'scale-guess';
}

const GUESS_SCALES = [1e3, 1e4, 1e6, 1e8, 1e9, 1e-3, 1e-4, 1e-6, 1e-8, 1e-9];

/**
 * Whether `line` states `figure`: some number on it equals the figure's value,
 * each read at its own scale (the figure's magnitude word; the line's own, or
 * else the declared scale of its table), within the rounding either was
 * written to. A match only at an undeclared power of ten is reported as a
 * `scale-guess`: the digits agree but nothing says the units do, which is for
 * a person to accept, not for a check to pass.
 */
export function figureOnLine(figure: NumberToken, line: string, declared = 1): FigureMatch | null {
  const want = Math.abs(figure.mantissa * figure.magnitude);
  const wantTol = tolerance(figure);
  let guess: FigureMatch | null = null;
  for (const token of numbersIn(line)) {
    if (token.dateLike && !figure.dateLike) continue;
    if (figure.unit === '%' && token.unit && token.unit !== '%') continue;
    const scales = token.scaled ? [1] : declared !== 1 ? [declared, 1] : [1];
    for (const scale of scales) {
      const got = Math.abs(token.mantissa * token.magnitude * scale);
      if (Math.abs(got - want) <= Math.max(wantTol, tolerance(token, scale)) + 1e-9 * Math.max(1, want)) {
        return { token, scale, how: 'exact' };
      }
    }
    if (!guess && !token.scaled) {
      for (const g of GUESS_SCALES) {
        const got = Math.abs(token.mantissa * g);
        if (Math.abs(got - want) <= Math.max(wantTol, tolerance(token, g)) + 1e-9 * Math.max(1, want) && token.mantissa !== 0) {
          guess = { token, scale: g, how: 'scale-guess' };
          break;
        }
      }
    }
  }
  return guess;
}

/** A figure written for a reader: the value at its scale, the magnitude word, the unit. */
export function displayFigure(n: NumberToken): string {
  return n.raw;
}

/** The figure's value as a plain number (magnitude applied). */
export function figureValue(n: NumberToken): number {
  return n.mantissa * n.magnitude * (/^[-−]|\(/.test(n.raw) ? -1 : 1);
}
