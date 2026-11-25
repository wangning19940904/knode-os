import { LlmClient } from '../llm/client.js';
import { resolveTemporal } from '../store/resolver.js';
import { isListQuestion } from './excerpts.js';

/**
 * What kind of question `ask` is answering (docs/design/30 §1).
 *
 * The 2026-11 corpus benchmark scored `ask` 0.52 on aggregate tasks and 0.29
 * on deep-hop ones: one top-k search cannot list every case, and one search
 * cannot cross two relations. So `ask` routes:
 *
 *   lookup     "what / who / when is X": today's single-shot path, same cost.
 *   list       "which / list every …": the claims about what the question
 *              names, enumerated (src/search/enumerate.ts), not the top few.
 *   aggregate  "how many / how often / the most …": the same enumeration with
 *              counts over the whole match, not over what fits in a prompt.
 *   timeline   "history of / since 2024 / in chronological order": the
 *              enumeration in event-time order, replaced facts included.
 *   multihop   "the X of the Y that …": a bounded walk entity → relations →
 *              entity, reading the passages where each hop's two ends meet.
 *
 * Rules decide, from the question's wording; they cost nothing. With
 * `classifier: 'model'` a question the rules call a lookup only for want of a
 * cue is put to the Judge stage's model once (a short JSON answer); the rules'
 * answer stands when that call fails.
 */

export type QuestionKind = 'lookup' | 'list' | 'aggregate' | 'timeline' | 'multihop';

export interface QuestionRoute {
  kind: QuestionKind;
  /** World-time window the question names ("in 2025", "since March 2026", "2026Q2"), as ISO instants. */
  range: { from: string | null; to: string | null; text: string } | null;
  /** Which rule or step decided. */
  by: string;
}

/*
 * Every open-ended gap in these patterns is bounded ({0,120}, not *): a
 * question is classified on every Ask, and an unbounded gap between two
 * repeated words backtracks over the whole text (a 57,000-character paste
 * took seconds). The router also reads at most `routedText` of a question.
 */
const TIMELINE = [
  /时间线|时间轴|从早到晚|从晚到早|按时间(顺序)?|先后顺序|历次|演变|变迁|历程|沿革|最早.{0,30}最后|首次.{0,30}(?:最后|最终)/,
  /\bfirst\b[^?]{0,120}?\b(?:last|finally)\b[^?]{0,120}?\b(?:when|which week|who)\b|\bwhen\b[^?]{0,120}?\bfirst\b[^?]{0,120}?\b(?:last|finally)\b|\btimeline\b|\bchronolog|\bhistory of\b|\bin (chronological )?order\b|\bover time\b|\bevolv(e|ed|ing)\b|\bhow has [^?.]{1,80}? changed\b|\bsequence of\b/i,
];

const AGGREGATE = [
  /多少|(?<![那这第])几[次个家条篇份项位年月天起名人种类款]|总共|一共|合计|总数|总额|平均|最多|最少|最高|最低|最好|最差|最大|最小|最快|最慢|最强|最弱|最贵|最便宜|排名|排第[一二三四五六七八九十几\d]|第[一二三四五六七八九十\d]+名|前[一二三四五六七八九十\d]+名|占比|增长了?多少|频率/,
  /\bhow (many|much|often)\b|\bcount\b|\bnumber of\b|\btotal\b|\bsum\b|\baverage\b|\bmean\b|\b(most|least|highest|lowest|largest|smallest|best|worst|biggest|fastest|cheapest)\b|\brank(ed|ing)?\b|\bpercentage\b/i,
];

/**
 * A question that crosses a relation before it can be answered: a noun phrase
 * qualified by a clause ("the company that acquired X"), a chain of "of the"
 * ("the CEO of the parent of X"), a possessive chain, or a Chinese 的-chain
 * ("X的母公司的CEO"). A miss costs what today's path costs; a false hit costs
 * a walk over a few relations.
 */
/**
 * A hop inside one clause whose description holds a superlative: "谁是比亚迪最大的
 * 电池供应商之一的创始人？" asks about the founder of the supplier the
 * superlative picks, so the superlative describes what to find, not a count.
 */
const SUPERLATIVE_HOP = /(?:谁|哪)[^，,。？?；;]{0,20}最[大小高低多少好强差][^，,。？?；;的]{0,4}的[^，,。？?；;的]{1,12}的[^，,。？?；;的]{1,10}|最[大小高低多少好强差][^，,。？?；;的]{0,4}的[^，,。？?；;的]{1,12}的[^，,。？?；;的]{1,10}(?:是谁|是哪)/;

const MULTIHOP = [
  // "高瓴最新买入的那家公司是谁创立的？": a described thing, and who made or runs it
  /的那(?:一)?[个位家起项名件只][^，。？?]{0,10}?(?:是谁|由谁|被谁)/,
  /\b(?:the|a|an)\s+(?:[\w-]+\s+){0,3}?(?:that|which|who|whose)\s+(?!is\b|are\b|was\b|were\b)\w+/i,
  /\bof the\b[^?]{0,80}?\bof (?:the\b|[A-Z])/,
  /'s\s+[\w-]+(?:\s+[\w-]+)?'s\b/,
  /\b(?:where|when) (?:was|did|is) the\s+[\w-]+\s+(?:that|which|who)\b/i,
  /的[^，。？?、\s]{1,12}的[^，。？?、\s]{1,12}(是谁|是什么|是哪|在哪|叫什么|有哪些|有多少)/,
  /(所在|隶属|母公司|子公司|创始人|投资方|收购方|前任|继任)[^，。？?]{0,8}的/,
];

/**
 * A chain of questions: a later clause asks about something an earlier clause
 * identifies only by description, so it has to be found first. The earlier
 * part asks for it ("是谁处理好的？", "哪个项目？", "who fixed INC-7?"),
 * describes it ("提出风险R-03的人", "一起由客户升级的事故", "an engineer"),
 * or labels it ("…的那一家记作甲"); the later clause refers back ("此人",
 * "那个项目", "同一个客户", "新负责人", "that person", "甲"). The benchmark's
 * deep-hop and nonlexical-hop questions are all of this shape, and none of
 * them matched MULTIHOP, which wants the hops inside one noun phrase.
 *
 * Not chains (an independent review, 2026-11-16, found each one walked):
 *   - a pronoun for something the question names ("给我讲一个关于茅台的故事，
 *     它…", "What is Atlas? When did it launch?"): a bare 他 / 她 / 它 / he /
 *     she / they counts only after a clause that opens with the question word
 *     (谁 / 哪家 … / who / which …), whose answer it then stands for; "it",
 *     "its" and a bare 其 never count;
 *   - a plural back to a list (它们, 他们, those, "List all incidents. Who
 *     fixed them?"): they / them / their count only after a clause opening
 *     with who, never after a list;
 *   - an introducer that is part of a longer word (的人均, 的人工智能, 的人民币)
 *     or an indefinite that is not a person or a thing to find ("讲一个关于…
 *     的故事"): introducers are words, and 一个 / 一起 introduce only the
 *     nouns the walk can find (人, 项目, 客户, 事故 …);
 *   - a question whose list or count is what finds the thing ("哪家公司今年
 *     营收最高，它的净利润…", "Which suppliers were late? Who manages that
 *     supplier?"): the cue comes before the back-reference, and the count or
 *     list route computes it. When the list or count is asked of the thing
 *     found ("谁修复了INC-1？他今年修复过哪些事故？") it is a chain: the
 *     enumeration would have nothing named to enumerate.
 */
/** What an English indefinite or back-reference can stand for. */
const EN_NOUN = '(?:person|engineer|employee|colleague|analyst|executive|founder|investor|partner|lawyer|doctor|project|team|customer|client|supplier|vendor|incident|risk|company|firm|bank|fund|agency|owner|manager|product)';
/**
 * The other side of a company's standing relation: "小鹏汽车最大的股东", "the
 * largest shareholder of Xpeng". A superlative on one of these picks the one
 * partner the documents name, not a ranking the question computes.
 */
const PARTNER_ROLE = '(?:股东|客户|供应商|买家|债权人|投资人|投资方|投资者|合作伙伴|合作方|竞争对手|对手|子公司|经销商|代工厂|承销商|持有人|重仓股)';
const PARTNER_ROLE_EN = '(?:shareholders?|stockholders?|investors?|customers?|clients?|suppliers?|vendors?|creditors?|lenders?|partners?|competitors?|rivals?|subsidiar(?:y|ies)|backers?|holders?|holdings?|buyers?|underwriters?)';
const PARTNER_SUPERLATIVE: [RegExp, string][] = [
  [new RegExp(`最大(?:的)?(?:单一)?(${PARTNER_ROLE})`, 'g'), '的$1'],
  [new RegExp(`\\b(?:largest|biggest|top)\\s+(${PARTNER_ROLE_EN})\\b`, 'gi'), '$1'],
];
const ENTITY_NOUN = '(?:人|工程师|同事|员工|负责人|项目|客户|甲方|供应商|事故|故障|隐患|风险|公司|企业|产品|团队|小组|组|部门|合同|订单)';

/** Introducers that may stand anywhere in an earlier clause; an explicit back-reference may follow any of them. */
const CHAIN_INTRO = [
  // an interrogative that asks for one person or thing, not a time or an amount
  /谁|哪(?:一)?[个位家起项名组件条](?!些)/,
  // a description: "提出R-03的人" (not 的人均 / 的人工智能 / 的人民币 …), "修复它的工程师", "升级的那起事故", "换了负责人"
  /的(?:人(?![均工民口才数员事气们类生物格性力体群权身脉选家心])|工程师|同事|员工|那位|那个|那起|那一起|那一家|那家)|换了?\S{0,3}负责人/,
  // an indefinite one of what the walk can find: "一起由客户升级的事故", "另一个组", "一个项目" (not "一个关于茅台的故事")
  // 一位 / 一名 / 一家 already say a person or an organisation, whatever the noun ("推荐了一位理疗师")
  new RegExp(`(?<!第)[一另]\\s*(?:[位名家]|[起个项件]\\s*(?:[^，。？?；;、\\s]{0,12}?的)?${ENTITY_NOUN})`),
  new RegExp(`\\bwho(?:m|se)?\\b(?!\\s+(?:are|were)\\b)|\\bwhich\\s+(?!\\w+s\\b)(?!(?:is|are|was|were|has|have|had|does|do|did|will|would|can|could|this|these|those|of|one|ones)\\b)\\w+|\\b(?:a|an|another|some|one)\\s+(?:[\\w-]+\\s+)?${EN_NOUN}\\b|\\bthe\\s+(?:one|${EN_NOUN})\\s+(?:who|that|which)\\b`, 'i'),
];

/**
 * A clause that opens with the question word or with an indefinite one ("An
 * engineer fixed…", "有一家公司…"): a bare pronoun in a later clause stands for
 * its answer.
 */
const CHAIN_OPENING = [
  new RegExp(`^\\s*(?:请问|那么|并且|而且|又|是|由)?\\s*(?:谁|哪(?:一)?[个位家名项件组](?!些)|有?(?<!第)[一另]\\s*(?:[位名家]|[起个项件]\\s*(?:[^，。？?；;、\\s]{0,12}?的)?${ENTITY_NOUN}))`),
  // "这家公司的创始人是谁，他…": the clause asks who or which one of something it describes (not "马斯克是谁？他…")
  /的[^，,。？?；;的]{0,10}是(?:谁|哪(?:一)?[个位家名])\s*[，,。？?；;：:—]?\s*$/,
  // "腾讯最大股东是谁，它…": the one partner a superlative picks
  new RegExp(`最大(?:的)?(?:单一)?${PARTNER_ROLE}是(?:谁|哪(?:一)?[个位家名])\\s*[，,。？?；;：:—]?\\s*$`),
  // "收购了华为荣耀的那家公司，它…": the clause is a described thing and nothing else
  /的那(?:一)?[个位家起项名件只][^，,。？?；;的什么谁哪吗呢怎如多几]{0,6}\s*[，,—]?\s*$/,
];

/** The English openings: only where a sentence starts ("The CEO, who joined…" is a relative clause, not a question). */
const CHAIN_OPENING_EN = [
  new RegExp(`^\\s*(?:and\\s+|then\\s+|so\\s+)?(?:who(?:m)?\\b(?!\\s+(?:are|were)\\b)|which\\s+(?!\\w+s\\b)\\w+|(?:a|an|another|one)\\s+(?:[\\w-]+\\s+)?${EN_NOUN}\\b)`, 'i'),
];

/** An English opening that asks which one thing ("Which bank underwrote…", "A fund bought…"): a later "its" stands for it, where after "who" it is what the question named. */
const CHAIN_OPENING_EN_THING = new RegExp(`^\\s*(?:and\\s+|then\\s+|so\\s+)?(?:which\\s+(?!\\w+s\\b)\\w+|(?:a|an|another|one)\\s+(?:[\\w-]+\\s+)?${EN_NOUN}\\b)`, 'i');
const CHAIN_THING_PRONOUN_EN = /\bits\b/i;

/** A reference back that names what it refers to as one thing: needs an introducer in an earlier clause. */
const CHAIN_BACK = [
  // 这家券商 / 这名分析师 / 这个客户, and the role a later clause names for the other side of an event (收购方 after 被收购了)
  new RegExp(`这(?:一)?[家名只](?!些)|这个${ENTITY_NOUN}|(?:收购方|买方|卖方|接盘方|接替者|继任者|接任者|新东家)`),
  /此人|该人|这个人|那个人|这位|那位|对方|同一(?![周天日月年时期次类种样]|[个位家起名项件]?(?:问题|事))|那(?:一)?[个位家起项名件条组只](?!些)|该(?:项目|组|客户|事故|风险|员工|工程师|同事|公司)|新(?:的)?负责人|前者|后者|其(?:位置|名下)/,
  new RegExp(`\\b(?:that|this|the same)\\s+(?:one|${EN_NOUN})\\b|\\bthe new (?:owner|lead|manager|assignee)\\b|\\bthe (?:former|latter)\\b`, 'i'),
];

/** A bare pronoun: stands for the answer of a clause that opened with the question word. */
const CHAIN_PRONOUN = [/(?<![其吉])[他她](?!们)|(?<!其)它(?!们)/, /\b(?:he|she|him|her|his|hers|they|them|their|theirs)\b/i];

/**
 * A clause that asks who, wherever the word stands ("二部平台组的事故是谁修复的？",
 * "fixed by whom?"): a later 他 / 她 / he / she stands for that person, not 它
 * ("…是谁的主意？它后来…" is about what the question named).
 */
const CHAIN_ASKS_WHO = [/谁/, /\bwhom\b/i, /(?<!第)[一另]\s*[位名]/];
/** "马斯克是谁？" asks who someone named is: the 他 after it is that person, nothing to find. */
const NAMED_WHO = /^\s*[^的，,。？?；;]{1,12}是谁\s*[，,。？?；;]?\s*$/;
/** "Who is Jensen Huang?": the same in English (case-sensitive: a name is capitalised). */
const NAMED_WHO_EN = /^\s*[Ww]ho\s+(?:is|was)\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*\s*[?.]?\s*$/;
const CHAIN_PERSON_PRONOUN = [/(?<![其吉])[他她](?!们)/, /\b(?:he|she|him|her|his|hers|they|them|their|theirs)\b/i];

/** A label the question gives what it describes, used again later: "…的那一家记作甲；甲头一回…". */
const CHAIN_LABEL = /(?:记作|记为|称作|称为|叫作)\s*[“"「]?([甲乙丙丁戊己庚辛壬癸]|[A-Z])(?![A-Za-z])/g;

/** Where a clause ends: a sentence or a comma, a dash, a colon, a semicolon, a line. */
const CLAUSE_END = /[。？?！!；;，,：:—\n]|\.\s/g;

/** The characters of a question the router reads: a long paste is cut to its head and its tail, where the question is. */
const HEAD_CHARS = 400;
const TAIL_CHARS = 200;

/** A question as the router reads it: at most HEAD_CHARS + TAIL_CHARS characters. */
export function routedText(question: string): string {
  return question.length <= HEAD_CHARS + TAIL_CHARS ? question : `${question.slice(0, HEAD_CHARS)}\n${question.slice(-TAIL_CHARS)}`;
}

/** Where the clause that refers back starts, or -1 when the question is no chain. */
function chainAt(question: string): number {
  const starts = [0];
  for (const m of question.matchAll(CLAUSE_END)) starts.push((m.index ?? 0) + m[0].length);
  const labels = new Set<string>();
  let introduced = false;
  let asked = false;
  let askedWho = false;
  let askedThing = false;
  for (let i = 0; i < starts.length; i++) {
    const at = starts[i];
    const clause = question.slice(at, starts[i + 1] ?? question.length);
    if (i > 0) {
      const back = (introduced && CHAIN_BACK.some((re) => re.test(clause)))
        || (asked && CHAIN_PRONOUN.some((re) => re.test(clause)))
        || (askedWho && CHAIN_PERSON_PRONOUN.some((re) => re.test(clause)))
        || (askedThing && CHAIN_THING_PRONOUN_EN.test(clause))
        || [...labels].some((l) => clause.includes(l));
      if (back) return at;
    }
    // a sentence starts at the beginning, or after 。？！；, a line, or ". ": not after a comma
    const sentence = i === 0 || /[。？?！!；;\n]\s*$|\.\s+$/.test(question.slice(Math.max(0, at - 3), at));
    if (CHAIN_INTRO.some((re) => re.test(clause))) introduced = true;
    if (CHAIN_OPENING.some((re) => re.test(clause)) || (sentence && !NAMED_WHO_EN.test(clause) && CHAIN_OPENING_EN.some((re) => re.test(clause)))) asked = true;
    if (sentence && CHAIN_OPENING_EN_THING.test(clause)) askedThing = true;
    if (CHAIN_ASKS_WHO.some((re) => re.test(clause)) && !NAMED_WHO.test(clause)) askedWho = true;
    for (const m of clause.matchAll(CHAIN_LABEL)) labels.add(m[1]);
  }
  return -1;
}

/** A comparison of things the question names: the answer is one of them, nothing to find ("谁的装机量更大", "which was cheaper"). */
const COMPARISON = [
  /更[高大多低少好快慢强弱贵]|更便宜/,
  /\b(?:more|less|fewer|higher|lower|bigger|larger|smaller|faster|slower|better|worse|cheaper|costlier)\b/i,
];

/** A count, a list or a comparison: what finds the thing without a walk (the aggregate and list routes, or the names given). */
function countsOrLists(text: string): boolean {
  for (const [re, role] of PARTNER_SUPERLATIVE) text = text.replace(re, role);
  return AGGREGATE.some((re) => re.test(text)) || isListQuestion(text) || COMPARISON.some((re) => re.test(text));
}

/**
 * One clause that describes what to find by what it did and then asks about it:
 * "提出R-03的人现在在哪个组？", "修复INC-7的工程师现在负责哪个项目？". The
 * description needs an act (提出, 修复, 收购 …), so "我们公司的人…" is no hop;
 * the rest of the clause must ask something of what is found, not what it is
 * ("提出R-03的人是谁" is one step) or how many there are ("…的工程师有几个").
 */
const HOP_ACT = '(?:提出|修复|修好|负责|处理|升级|上报|发现|引入|创建|编写|签署|签下|收购|推荐|介绍|发起|主导|批准|审批|接手|接替|创立|创办|投资|买入|卖出|提交|关闭|解决|跟进|对接|带领|领导|发布|起草|设计|开发|承销|举报)';
const HOP_HEAD = '(?:人(?![均工民口才数员事气们类生物格性力体群权身脉选家心])|工程师|同事|员工|负责人|团队|小组|公司|企业|客户|项目|事故|供应商|分析师|机构|券商|基金)';
const DESCRIBED_HOP = new RegExp(`^\\s*(?:请问|那么)?\\s*([^，,。？?；;的]{0,12}${HOP_ACT}[^，,。？?；;的]{1,16})的(?:那(?:一)?[个位家名])?${HOP_HEAD}([^，,。？?；;]{0,40})`);

function describedHop(text: string): boolean {
  const starts = [0, ...[...text.matchAll(CLAUSE_END)].map((m) => (m.index ?? 0) + m[0].length)];
  return starts.some((at) => {
    const m = DESCRIBED_HOP.exec(text.slice(at, at + 120));
    if (!m) return false;
    const [, description, rest] = m;
    return !/^\s*(?:是|叫|为|有|就是)/.test(rest) && /哪|什么|谁|多少|几|吗|如何|怎么|怎样/.test(rest) && !countsOrLists(description);
  });
}

/**
 * True when a later clause asks about something an earlier part identified
 * only by description, and that part is not itself a count or a list (which
 * the enumeration answers).
 */
export function isChainQuestion(question: string): boolean {
  const chained = (text: string) => {
    const at = chainAt(text);
    return (at >= 0 && !countsOrLists(text.slice(0, at))) || describedHop(text);
  };
  if (question.length <= HEAD_CHARS + TAIL_CHARS) return chained(question);
  // a long paste: the question is at its start or at its end (the last sentence or two)
  return chained(question.slice(0, HEAD_CHARS)) || chained(lastSentences(question.slice(-TAIL_CHARS)));
}

/** The last two sentences of a text: where a question after a paste stands. */
function lastSentences(text: string): string {
  const ends = [...text.matchAll(/[。？?！!\n]|\.\s/g)].map((m) => (m.index ?? 0) + m[0].length).filter((i) => i < text.trimEnd().length);
  return text.slice(ends.length >= 2 ? ends[ends.length - 2] : 0).trim();
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * The time window a question names, in a form `resolveTemporal` reads: a year,
 * a quarter or half, a month, "between A and B", "since A", "before B" (and
 * the Chinese forms). Null when it names none, or names it in a way these
 * patterns do not read.
 */
export function questionRange(question: string): QuestionRoute['range'] {
  const q = question;
  const monthOf = (name: string) => String(MONTHS.indexOf(name.toLowerCase()) + 1).padStart(2, '0');
  const day = (y: string, mo: string, d: string) => `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  // a day bounding the window, before the month forms read its month as the window: "从启动到2026年5月1日为止" is
  // everything up to that day, not May 2026 (which left the timeline questions of the reports packs with no claim)
  const ZH_DAY = String.raw`(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]`;
  let m = new RegExp(`${ZH_DAY}\\s*(?:至|到|-|—|~)\\s*${ZH_DAY}`).exec(q);
  if (m) return parse(`${day(m[1], m[2], m[3])}..${day(m[4], m[5], m[6])}`, m[0]);
  m = new RegExp(`(?:截至|截止(?:到|至)?|到|至|直到|为止)\\s*${ZH_DAY}|${ZH_DAY}\\s*(?:为止|之前|以前|前)`).exec(q);
  if (m) return parse(`..${m[1] ? day(m[1], m[2], m[3]) : day(m[4], m[5], m[6])}`, m[0]);
  m = new RegExp(`(?:自|从)\\s*${ZH_DAY}\\s*(?:以来|起|开始)|${ZH_DAY}\\s*(?:以来|之后|以后|起)`).exec(q);
  if (m) return parse(`${m[1] ? day(m[1], m[2], m[3]) : day(m[4], m[5], m[6])}..`, m[0]);
  // Chinese forms first: they carry their own markers
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月?\s*(?:至|到|-|—|~)\s*(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(q);
  if (m) return parse(`${m[1]}-${m[2].padStart(2, '0')}..${m[3]}-${m[4].padStart(2, '0')}`, m[0]);
  m = /(\d{4})\s*年?\s*(?:至|到|-|—|~)\s*(\d{4})\s*年/.exec(q);
  if (m) return parse(`${m[1]}..${m[2]}`, m[0]);
  m = /(?:自|从)\s*(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?\s*(?:以来|起|开始)?/.exec(q);
  if (m && /以来|起|开始|至今/.test(q)) return parse(`${m[1]}${m[2] ? `-${m[2].padStart(2, '0')}` : ''}..`, m[0]);
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(q);
  if (m) return parse(`${m[1]}-${m[2].padStart(2, '0')}`, m[0]);
  m = /(\d{4})\s*年\s*(上半年|下半年|第?[一二三四1-4]\s*季度|Q[1-4])/i.exec(q);
  if (m) {
    const part = m[2];
    const quarter = /[一1]/.test(part) ? 1 : /[二2]/.test(part) ? 2 : /[三3]/.test(part) ? 3 : 4;
    const token = part === '上半年' ? `${m[1]}-01..${m[1]}-06` : part === '下半年' ? `${m[1]}-07..${m[1]}-12` : `${m[1]}Q${quarter}`;
    return parse(token, m[0]);
  }
  // English
  const EN_DAY = `(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})|(\\d{4})-(\\d{2})-(\\d{2})`;
  const enDay = (x: RegExpExecArray, at: number) => (x[at] ? day(x[at + 2], monthOf(x[at]), x[at + 1]) : day(x[at + 3], x[at + 4], x[at + 5]));
  m = new RegExp(`\\b(?:until|through|as of|up to|by|before)\\s+(?:${EN_DAY})`, 'i').exec(q);
  if (m) return parse(`..${enDay(m, 1)}`, m[0]);
  m = new RegExp(`\\b(?:since|after|from)\\s+(?:${EN_DAY})`, 'i').exec(q);
  if (m && !/\b(?:to|until|through)\s+\w/i.test(q.slice(m.index + m[0].length, m.index + m[0].length + 12))) return parse(`${enDay(m, 1)}..`, m[0]);
  m = /\bbetween\s+(\d{4})(?:-(\d{2}))?\s+and\s+(\d{4})(?:-(\d{2}))?\b/i.exec(q);
  if (m) return parse(`${m[1]}${m[2] ? `-${m[2]}` : ''}..${m[3]}${m[4] ? `-${m[4]}` : ''}`, m[0]);
  m = /\bfrom\s+(\d{4})\s+(?:to|until|through)\s+(\d{4})\b/i.exec(q);
  if (m) return parse(`${m[1]}..${m[2]}`, m[0]);
  m = new RegExp(`\\b(?:since|after|from)\\s+(?:(${MONTHS.join('|')})\\s+)?(\\d{4})\\b`, 'i').exec(q);
  if (m) return parse(`${m[2]}${m[1] ? `-${monthOf(m[1])}` : ''}..`, m[0]);
  m = new RegExp(`\\b(?:before|until|prior to)\\s+(?:(${MONTHS.join('|')})\\s+)?(\\d{4})\\b`, 'i').exec(q);
  if (m) return parse(`..${m[2]}${m[1] ? `-${monthOf(m[1])}` : ''}`, m[0]);
  m = /\b(Q[1-4])\s*(\d{4})\b|\b(\d{4})\s*(Q[1-4])\b/i.exec(q);
  if (m) return parse(`${m[2] ?? m[3]}${(m[1] ?? m[4]).toUpperCase()}`, m[0]);
  m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i').exec(q);
  if (m) return parse(`${m[2]}-${monthOf(m[1])}`, m[0]);
  m = /\b(\d{4})-(\d{2})\b/.exec(q);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return parse(`${m[1]}-${m[2]}`, m[0]);
  m = /(?:\bin\s+|\bduring\s+|\bof\s+)(\d{4})\b|(\d{4})\s*年/.exec(q);
  if (m) return parse(m[1] ?? m[2], m[0]);
  return null;
}

function parse(token: string, text: string): QuestionRoute['range'] {
  const year = Number(/\d{4}/.exec(token)?.[0]);
  if (!(year >= 1900 && year <= 2200)) return null;
  try {
    const t = resolveTemporal({ validRange: token });
    if (!t.validFrom && !t.validTo) return null;
    return { from: t.validFrom, to: t.validTo, text: text.trim() };
  } catch {
    return null;
  }
}

/** The kind of a question by its wording alone (its head and tail when it is a long paste: `routedText`). */
export function classifyQuestion(full: string): QuestionRoute {
  const question = routedText(full);
  const range = questionRange(question);
  if (TIMELINE.some((re) => re.test(question))) return { kind: 'timeline', range, by: 'rule:timeline' };
  // before the counts and lists: what those would enumerate is the thing the question has yet to find
  if (isChainQuestion(full)) return { kind: 'multihop', range, by: 'rule:chain' };
  if (SUPERLATIVE_HOP.test(question)) return { kind: 'multihop', range, by: 'rule:multihop' };
  if (AGGREGATE.some((re) => re.test(question))) return { kind: 'aggregate', range, by: 'rule:aggregate' };
  if (isListQuestion(question)) return { kind: 'list', range, by: 'rule:list' };
  if (MULTIHOP.some((re) => re.test(question))) return { kind: 'multihop', range, by: 'rule:multihop' };
  // a window and a plural is a list in time: "what did Acme announce in 2025"
  if (range && /\b(announce|release|launch|report|publish|sign|acquire)\w*\b|发布|宣布|签署|收购|报道/.test(question)) return { kind: 'list', range, by: 'rule:range' };
  return { kind: 'lookup', range, by: 'rule:default' };
}

const KINDS: QuestionKind[] = ['lookup', 'list', 'aggregate', 'timeline', 'multihop'];

const CLASSIFY_PROMPT = `Classify the question for a knowledge-base retriever. Kinds:
- lookup: one fact or description about something named ("what is X", "who founded X", "when did X happen").
- list: every case / item matching a condition ("which papers…", "list all…").
- aggregate: a count, total, average, maximum or ranking over many cases.
- timeline: how something developed over time, in order.
- multihop: needs one fact to find the thing another fact is about ("the CEO of the company that acquired X").
Answer with JSON only: {"kind": "<one of lookup|list|aggregate|timeline|multihop>"}`;

/**
 * `classifyQuestion`, and with `classifier: 'model'` one small model call
 * for a question the rules only defaulted to a lookup.
 */
export async function routeQuestion(question: string, opts: { classifier?: 'rules' | 'model'; llm?: LlmClient } = {}): Promise<QuestionRoute> {
  const ruled = classifyQuestion(question);
  if (opts.classifier !== 'model' || ruled.by !== 'rule:default' || !opts.llm?.enabled) return ruled;
  try {
    const r = await opts.llm.completeJson<{ kind?: string }>([
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: routedText(question) },
    ], { maxTokens: 30 });
    const kind = String(r?.kind ?? '').toLowerCase() as QuestionKind;
    return KINDS.includes(kind) ? { kind, range: ruled.range, by: 'model' } : ruled;
  } catch {
    return ruled;
  }
}
