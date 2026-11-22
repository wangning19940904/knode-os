import { extractFinalAnswer } from '../metrics/text.js';
import type { Task } from '../types.js';
import { containsTerm, foldThousands } from './lists.js';

/**
 * Model-free reading of a short answer (docs/design/28 §4): does the
 * `Final answer:` line name the gold value, a stale value the corpus once
 * stated for the same thing, or neither — and did the answer decline? This is
 * how `value` tasks are scored, and how any task that names its stale values
 * (`meta.stale`) gets a stale-answer rate beside its correctness.
 */

/** Phrases that decline to answer, in the languages the packs use. */
const ABSTAIN = /(无法确定|无法判断|不能确定|没有(提到|记载|说明|信息|相关)|未(提及|提到|说明)|不清楚|不知道|资料中没有|材料中没有|not (stated|mentioned|specified|given|in the (sources|documents|materials))|cannot (determine|tell|find)|can't (determine|tell|find)|no (information|record|mention)|unknown|unable to (determine|find)|do not know|don't know)/i;

export function declines(text: string): boolean {
  return ABSTAIN.test(text);
}

/** A number as an answer writes it: thousands separators allowed, and a 万 / 亿 right after it. */
const NUMBER = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
const MAGNITUDE: Record<string, number> = { 万: 1e4, 亿: 1e8 };
/**
 * English scales after a number: "1837k", "$9.932 million", "1.2bn". A
 * one-letter scale must end the word ("5 kg" is not 5,000).
 */
const EN_MAGNITUDE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, trillion: 1e12 };
const ZH_SCALE = /^\s*([万亿])/;
const LETTER_SCALE = /^\s?(k|K|M|B)(?![A-Za-z])/;
const WORD_SCALE = /^\s*(thousand|million|billion|trillion|mn|bn)(?![A-Za-z])/i;

/** The scale written right after a number, and how long it is ("" and 1 when none). */
function scaleAt(rest: string): { scale: number; length: number } {
  const zh = rest.match(ZH_SCALE);
  if (zh) return { scale: MAGNITUDE[zh[1]], length: zh[0].length };
  const en = rest.match(LETTER_SCALE) ?? rest.match(WORD_SCALE);
  return en ? { scale: EN_MAGNITUDE[en[1].toLowerCase()], length: en[0].length } : { scale: 1, length: 0 };
}
const scaleAfter = (rest: string) => scaleAt(rest).scale;

/**
 * The numbers a text states, each as written ("134.7" of "134.7万") and,
 * after a scale (万, 亿, k, million, bn …), at its full size (1,347,000).
 */
export function numbersIn(text: string): { value: number; scaled: number }[] {
  const t = text.normalize('NFKC');
  return [...t.matchAll(NUMBER)].map((m) => {
    const value = Number(m[0].replace(/,/g, ''));
    return { value, scaled: value * scaleAfter(t.slice(m.index! + m[0].length)) };
  });
}

/** A gold written with its scale ("1837k", "$9.9 million"): its full size, else null. */
function scaledGold(v: string): number | null {
  const t = foldThousands(v.normalize('NFKC')).trim().replace(/^[$¥€£]/, '');
  const m = t.match(/^(-?\d+(?:\.\d+)?)(.*)$/);
  if (!m || !m[2].trim()) return null;
  const { scale, length } = scaleAt(m[2]);
  // the scale and nothing after it: "1837k", not "1837k users in week 19"
  return scale !== 1 && !m[2].slice(length).trim() ? Number(m[1]) * scale : null;
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** The magnitudes (万, 亿) a text works in: a reading in one of them may be given at full size, and the other way round. */
export function magnitudesIn(text: string): number[] {
  return Object.entries(MAGNITUDE).filter(([u]) => text.includes(u)).map(([, m]) => m);
}

/**
 * Is one of `values` named in `text`: as a whole term, or (numbers, with
 * `tolerance`) as a number within it.
 *
 * Rounded gold (docs/design/33 §5): a numeric gold is the figure in the unit
 * the corpus states it in, rounded as the question asks, and `tolerance`,
 * in that unit, is what the pack allows for the rounding of both sides (1.01
 * for a whole number, 0.0101 for two decimals). An answer may give the same
 * figure in another magnitude: "1,347,308人" for a gold of 135 when the
 * corpus counts in 万人. Such a reading is converted to the gold's unit and
 * held to the same tolerance, with no slack of its own, and only when (a) the
 * answer itself works in that magnitude (`magnitudes`, read from its whole
 * text: "单位为万人", a table in 万) and (b) the gold is large against its
 * tolerance (at least ten times it), so a converted number has to agree with
 * the gold in two or more significant figures and a stray large number in an
 * answer does not match a small gold by accident.
 */
export function namesValue(text: string, values: string[], tolerance?: number, magnitudes: number[] = []): boolean {
  if (values.some((v) => v && containsTerm(text, v))) return true;
  const nums = numbersIn(text);
  // a gold with its scale ("1837k") is named by the same figure at another scale ("1,837,000", "1.837 million"), exactly
  if (values.some((v) => {
    const g = v ? scaledGold(v) : null;
    return g !== null && nums.some((n) => same(n.scaled, g));
  })) return true;
  if (tolerance === undefined || !(tolerance > 0)) return false;
  return values.some((v) => {
    const plain = foldThousands(v).trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(plain)) return false;
    const gold = Number(plain);
    const near = (x: number) => Math.abs(x - gold) <= tolerance;
    const convertible = Math.abs(gold) >= 10 * tolerance;
    return nums.some((n) => near(n.value) || near(n.scaled) || (convertible && magnitudes.some((m) => near(n.scaled / m))));
  });
}

export interface ValueReading {
  /** The gold value is named. */
  gold: boolean;
  /** A stale value is named and the gold is not: answered with what used to be true (or what a look-alike holds). */
  stale: boolean;
  /** The answer declines. */
  declined: boolean;
}

/** The gold values of a task as a short answer may give them: `meta.goldTerms`, else the answer and its variants. */
export function goldTerms(t: Task): string[] {
  const own = t.meta?.goldTerms;
  if (Array.isArray(own) && own.length) return own.map(String);
  return [t.answer ?? '', ...(t.answers ?? [])].filter(Boolean);
}

/** The values the corpus once stated for what the task asks, as an answer may write them. */
export function staleTerms(t: Task): string[] {
  const stale = [...(Array.isArray(t.meta?.stale) ? t.meta!.stale : []), ...(Array.isArray(t.meta?.staleText) ? t.meta!.staleText : [])];
  return [...new Set(stale.map(String).filter(Boolean))];
}

export function readValue(t: Task, answerText: string): ValueReading {
  const final = extractFinalAnswer(answerText);
  const tolerance = typeof t.meta?.tolerance === 'number' ? t.meta.tolerance : undefined;
  // the magnitudes the whole answer works in, not only its final line ("单位为万人" above a table)
  const gold = namesValue(final, goldTerms(t), tolerance, magnitudesIn(answerText));
  const stale = !gold && namesValue(final, staleTerms(t));
  return { gold, stale, declined: !gold && declines(final) };
}
