import { attributeHead } from '../graph/claim-state.js';
import type { ChatMessage } from '../llm/client.js';

/**
 * Row labels of statement tables, normalized once per distinct label
 * (docs/design/38 §3.2 item 1): "营业收入", "Revenues" and "Net revenues" are
 * one key, `revenue`; "应付账款" and "Accounts payable, net" are
 * `accounts_payable`. The raw label is always kept beside the key, and a query
 * may match either.
 *
 * Three steps, cheapest first:
 *   1. cleanLabel — numbering (一、, (1)), lead words (其中：, 减：, Less:),
 *      "（损失以“－”号填列）", a unit in brackets, ", net", "(loss)" go;
 *   2. the synonym groups below, Chinese and English in one group (unlike
 *      claim attributes, which keep a key per language — design 29), then the
 *      claim attributes' own groups (attributeHead), so 在岗人数 / 人数 in a
 *      table read as they do in a claim;
 *   3. what is left can be put to a model, once per distinct cleaned label,
 *      through a LabelNormalizer; its answers are stored in `table_label_keys`
 *      (label_key → canonical), as `claim_attribute_keys` stores a subject's
 *      attribute keys, and the catalog view reads the canonical key through it.
 */

/** Groups: the first entry is the key; every spelling (cleaned, lower-cased) maps to it. */
const LINE_ITEMS: readonly (readonly string[])[] = [
  ['revenue', '营业收入', 'revenue', 'revenues', 'net revenue', 'net revenues', 'net sales', 'sales', 'sales revenue', 'operating revenue', 'operating revenues'],
  ['total_revenue', '营业总收入', 'total revenue', 'total revenues', 'total net revenue', 'total net revenues', 'total operating revenues', 'total net sales'],
  ['cost_of_revenue', '营业成本', 'cost of revenue', 'cost of revenues', 'cost of sales', 'cost of goods sold', 'costs of revenue', 'cost of net revenues'],
  ['total_operating_cost', '营业总成本', 'total costs and expenses', 'total operating costs and expenses', 'total operating costs'],
  ['total_operating_expenses', 'total operating expenses', 'operating expenses, total'],
  ['gross_profit', '毛利', '毛利润', 'gross profit', 'gross margin'],
  ['tax_and_surcharges', '税金及附加', '营业税金及附加'],
  ['selling_expenses', '销售费用', 'selling expenses', 'selling expense', 'sales and marketing', 'sales and marketing expenses', 'selling and marketing', 'selling and marketing expenses'],
  ['administrative_expenses', '管理费用', 'general and administrative', 'general and administrative expenses', 'administrative expenses', 'administrative expense', 'general, administrative and other'],
  ['sga_expenses', 'selling, general and administrative', 'selling, general and administrative expenses', 'selling, general, and administrative expenses'],
  ['rd_expenses', '研发费用', 'research and development', 'research and development expenses', 'research and development expense'],
  ['financial_expenses', '财务费用', 'finance costs', 'financial expenses', 'finance expenses'],
  ['interest_expense', '利息费用', 'interest expense', 'interest expenses', 'interest expense, net'],
  ['interest_income', '利息收入', 'interest income'],
  ['other_income', '其他收益', 'other income', 'other income, net'],
  ['investment_income', '投资收益', 'investment income'],
  ['fair_value_change_income', '公允价值变动收益', '公允价值变动损益', 'change in fair value', 'changes in fair value'],
  ['credit_impairment_loss', '信用减值损失'],
  ['asset_impairment_loss', '资产减值损失', 'impairment loss', 'impairment losses', 'impairment of goodwill'],
  ['asset_disposal_income', '资产处置收益'],
  ['operating_profit', '营业利润', 'operating income', 'income from operations', 'operating profit', 'loss from operations', 'operating loss', 'income from operations', 'operating (loss) income'],
  ['non_operating_income', '营业外收入', 'non-operating income', 'nonoperating income'],
  ['non_operating_expenses', '营业外支出', 'non-operating expenses', 'nonoperating expenses'],
  ['total_profit', '利润总额', 'income before income taxes', 'income before taxes', 'income before provision for income taxes', 'loss before income taxes', 'profit before tax', 'income before income tax', 'pre-tax income'],
  ['income_tax', '所得税费用', '所得税', 'income tax expense', 'income taxes', 'provision for income taxes', 'income tax', 'income tax provision', 'income tax expense, net'],
  ['net_income', '净利润', 'net income', 'net loss', 'net earnings', 'profit for the year', 'profit for the period', 'net profit'],
  ['net_income_parent', '归属于母公司股东的净利润', '归属于母公司所有者的净利润', '归属于上市公司股东的净利润', '归属于母公司普通股股东的净利润', 'net income attributable to common stockholders', 'net income attributable to the company', 'net income attributable to stockholders', 'net loss attributable to common stockholders', 'net income attributable to common shareholders'],
  ['net_income_parent_recurring', '归属于上市公司股东的扣除非经常性损益的净利润', '扣除非经常性损益后的净利润', '归属于母公司股东的扣除非经常性损益的净利润'],
  ['minority_interest_income', '少数股东损益', 'net income attributable to noncontrolling interests', 'net income attributable to non-controlling interests', 'net loss attributable to noncontrolling interests'],
  ['comprehensive_income', '综合收益总额', 'total comprehensive income', 'comprehensive income', 'comprehensive loss', 'total comprehensive loss'],
  ['eps_basic', '基本每股收益', 'basic earnings per share', 'earnings per share, basic', 'basic', 'net income per share, basic', 'net loss per share, basic', 'basic net income per share', 'basic net loss per share', 'net loss per share - basic', 'net income per share - basic', 'basic and diluted', 'basic and diluted net loss per share', 'net loss per share, basic and diluted', 'net loss per share - basic and diluted', 'basic and diluted loss per share', 'loss per share, basic and diluted', 'net loss per common share - basic and diluted'],
  ['eps_diluted', '稀释每股收益', 'diluted earnings per share', 'earnings per share, diluted', 'diluted', 'net income per share, diluted', 'net loss per share, diluted', 'diluted net income per share', 'diluted net loss per share', 'net loss per share - diluted', 'net income per share - diluted'],
  ['weighted_average_roe', '加权平均净资产收益率', 'weighted average return on equity'],
  ['cash', '货币资金', 'cash and cash equivalents', 'cash', 'cash and equivalents', 'cash and cash equivalent'],
  ['trading_financial_assets', '交易性金融资产', 'trading securities', 'short-term investments'],
  ['notes_receivable', '应收票据', 'notes receivable'],
  ['accounts_receivable', '应收账款', 'accounts receivable', 'trade receivables', 'trade accounts receivable', 'accounts receivable, trade'],
  ['receivables_financing', '应收款项融资'],
  ['prepayments', '预付款项', '预付账款', 'prepaid expenses', 'prepayments', 'advances to suppliers'],
  ['other_receivables', '其他应收款', 'other receivables'],
  ['inventory', '存货', 'inventory', 'inventories'],
  ['contract_assets', '合同资产', 'contract assets'],
  ['other_current_assets', '其他流动资产', 'other current assets', 'prepaid expenses and other current assets'],
  ['total_current_assets', '流动资产合计', 'total current assets'],
  ['long_term_equity_investments', '长期股权投资', 'equity method investments', 'investments in equity method investees'],
  ['fixed_assets', '固定资产', 'property and equipment', 'property, plant and equipment', 'property and equipment, net', 'property, plant and equipment, net', 'fixed assets'],
  ['construction_in_progress', '在建工程', 'construction in progress'],
  ['right_of_use_assets', '使用权资产', 'right-of-use assets', 'operating lease right-of-use assets', 'right of use assets'],
  ['intangible_assets', '无形资产', 'intangible assets', 'intangible assets, net'],
  ['goodwill', '商誉', 'goodwill'],
  ['deferred_tax_assets', '递延所得税资产', 'deferred tax assets', 'deferred income taxes'],
  ['total_non_current_assets', '非流动资产合计', 'total non-current assets', 'total noncurrent assets', 'total long-term assets', 'total other assets'],
  ['total_assets', '资产总计', '总资产', '资产合计', 'total assets'],
  ['short_term_borrowings', '短期借款', 'short-term borrowings', 'short-term loans', 'short-term debt', 'short term loans'],
  ['notes_payable', '应付票据', 'notes payable'],
  ['accounts_payable', '应付账款', 'accounts payable', 'trade payables', 'trade accounts payable', 'accounts payable, trade'],
  ['contract_liabilities', '合同负债', 'contract liabilities', 'deferred revenue', 'deferred revenues'],
  ['employee_benefits_payable', '应付职工薪酬', 'accrued compensation', 'accrued payroll', 'accrued salaries and wages'],
  ['taxes_payable', '应交税费', 'taxes payable', 'income taxes payable'],
  ['other_payables', '其他应付款', 'other payables'],
  ['accrued_expenses', 'accrued expenses', 'accrued liabilities', 'accrued expenses and other current liabilities', 'accounts payable and accrued expenses', 'accounts payable and accrued liabilities'],
  ['lease_liabilities', '租赁负债', 'lease liabilities', 'operating lease liabilities'],
  ['total_current_liabilities', '流动负债合计', 'total current liabilities'],
  ['long_term_borrowings', '长期借款', 'long-term debt', 'long-term borrowings', 'long-term loans', 'notes payable, net of current portion'],
  ['total_non_current_liabilities', '非流动负债合计', 'total non-current liabilities', 'total noncurrent liabilities', 'total long-term liabilities'],
  ['total_liabilities', '负债合计', '总负债', 'total liabilities'],
  ['share_capital', '股本', '实收资本', '实收资本（或股本）', '实收资本或股本', 'common stock', 'share capital', 'ordinary shares'],
  ['capital_reserve', '资本公积', 'additional paid-in capital', 'additional paid in capital', 'capital surplus'],
  ['treasury_stock', '库存股', 'treasury stock', 'treasury shares'],
  ['other_comprehensive_income', '其他综合收益', 'accumulated other comprehensive income', 'accumulated other comprehensive loss'],
  ['surplus_reserve', '盈余公积', 'statutory reserves', 'statutory reserve'],
  ['retained_earnings', '未分配利润', 'retained earnings', 'accumulated deficit', 'retained earnings (accumulated deficit)', 'accumulated earnings'],
  ['equity_parent', '归属于母公司所有者权益合计', '归属于母公司股东权益合计', '归属于上市公司股东的所有者权益', '归属于上市公司股东的净资产', '归属于母公司所有者权益', "total stockholders' equity attributable to the company", "total equity attributable to the company"],
  ['minority_equity', '少数股东权益', 'noncontrolling interests', 'non-controlling interests', 'noncontrolling interest', 'non-controlling interest'],
  ['total_equity', '所有者权益合计', '股东权益合计', '所有者权益（或股东权益）合计', "total stockholders' equity", 'total equity', "total stockholders' deficit", 'total deficit'],
  ['total_liabilities_and_equity', '负债和所有者权益总计', '负债和股东权益总计', '负债及所有者权益总计', '负债和所有者权益（或股东权益）总计', "total liabilities and stockholders' equity", 'total liabilities and equity', "total liabilities and stockholders' deficit"],
  ['operating_cash_flow', '经营活动产生的现金流量净额', 'net cash operating activities'],
  ['investing_cash_flow', '投资活动产生的现金流量净额', 'net cash investing activities'],
  ['financing_cash_flow', '筹资活动产生的现金流量净额', 'net cash financing activities'],
  ['net_change_in_cash', '现金及现金等价物净增加额', 'net increase in cash', 'net decrease in cash', 'net change in cash', 'net increase in cash and cash equivalents', 'net change in cash and cash equivalents', 'net decrease in cash and cash equivalents'],
  ['cash_end_of_period', '期末现金及现金等价物余额', 'cash and cash equivalents at end of period', 'cash and cash equivalents at end of year', 'cash - end of period', 'cash, end of period', 'cash at end of period', 'cash, end of year', 'cash at end of year', 'cash and cash equivalents, end of period', 'cash and cash equivalents, end of year', 'cash - end of year'],
  ['cash_beginning_of_period', '期初现金及现金等价物余额', 'cash and cash equivalents at beginning of period', 'cash and cash equivalents at beginning of year', 'cash - beginning of period', 'cash, beginning of period', 'cash at beginning of period', 'cash, beginning of year', 'cash and cash equivalents, beginning of period', 'cash and cash equivalents, beginning of year'],
  ['depreciation_amortization', '折旧与摊销', 'depreciation and amortization', 'depreciation and amortization expense'],
  ['weighted_average_shares', '加权平均股数', 'weighted average shares outstanding', 'weighted average number of shares outstanding', 'weighted average common shares outstanding', 'weighted average number of common shares outstanding'],
];

const LINE_ITEM: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of LINE_ITEMS) for (const s of group) if (!m.has(foldLabel(s))) m.set(foldLabel(s), group[0]);
  return m;
})();

/** Every key the synonym groups define. */
export const LINE_ITEM_KEYS: ReadonlySet<string> = new Set(LINE_ITEMS.map((g) => g[0]));

function foldLabel(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/shareholders'|shareholder's|stockholder's/g, "stockholders'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A label without what does not name the line item: numbering, lead words,
 * a "how negatives are written" note, a unit in brackets, a footnote mark,
 * ", net", "(loss)". Lower-cased, NFKC.
 */
export function cleanLabel(raw: string): string {
  let s = foldLabel(raw);
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    // numbering: 一、 （一） (1) 1. 1、 a) (a) i.
    s = s.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十\d]+[）)]|\d+(?:\.\d+)*[、.．)](?!\d)|[a-z][.)](?=\s)|\([a-z]\)|[ivx]+\.\s)\s*/, '');
    // lead words: 其中： 加： 减： 其中: less: add: plus:
    s = s.replace(/^(?:其中|加|减|包括|含|其他|less|add|plus|including)\s*[：:]\s*/, '');
    s = s.replace(/^(?:减|加)(?=[一-鿿]{2,})/, '');
    if (s === before) break;
  }
  s = s
    // "（损失以“－”号填列）", "(净亏损以"-"号填列)"
    .replace(/[（(][^（）()]*填列[）)]/g, '')
    // a unit or note reference in brackets: （元）, （元/股）, (%), (note 5), (注1)
    .replace(/[（(]\s*(?:元\/股|元|千元|万元|百万元|亿元|%|股|万股|美元|美元\/股|注\s*\d*|附注[^）)]*|notes?\s*\d+[a-z]?)\s*[）)]/g, '')
    // English parentheticals that only say the sign: (loss), (deficit), (benefit), (used in) …
    .replace(/\s*\((?:loss|losses|income|deficit|benefit|expense|gain|gains|net|decrease|increase|used in|provided by|accumulated deficit|unaudited)\)/g, '')
    .replace(/\(\s*\)/g, '')
    // footnote marks
    .replace(/(?:\s*\*+|\s*\(\d\)|\s*\[\d\]|[¹²³⁴⁵⁶⁷⁸⁹])$/, '')
    // ", net" and ", net of …"
    .replace(/\s*[,，-]\s*net(?:\s+of\b.*)?$/, '')
    .replace(/[：:]$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "net cash provided by / used in / (used in) provided by operating activities" → "net cash operating activities"
  s = s.replace(/^net cash (?:(?:provided|used|generated|\(used|\(provided)\s*(?:by|in|from|for)?\)?\s*(?:\(?(?:provided|used|generated)\s*(?:by|in|from|for)?\)?\s*)?)(?:by\s+|from\s+)?(operating|investing|financing) activities.*$/, 'net cash $1 activities');
  s = s.replace(/^net (?:increase|decrease|change)(?:\s*(?:\/|and|or)\s*(?:increase|decrease))? in cash\b/, (m) => m.replace(/\s*(?:\/|and|or)\s*(?:increase|decrease)/, ''));
  return s;
}

/**
 * The key a row label stands for, without a model: the line item's key when
 * a synonym group holds its cleaned form, the claim attributes' group head
 * when theirs does (design 29), else the cleaned label itself.
 */
export function labelKey(raw: string): string {
  const cleaned = cleanLabel(raw);
  if (!cleaned) return foldLabel(raw);
  const direct = LINE_ITEM.get(cleaned);
  if (direct) return direct;
  const head = attributeHead(cleaned);
  if (head && head !== cleaned) return head;
  return cleaned;
}

/** Whether a key came from a synonym group (rather than being the cleaned label itself). */
export function isKnownKey(key: string): boolean {
  return LINE_ITEM_KEYS.has(key);
}

/* --------------------------- the model's step --------------------------- */

export interface LabelMapping {
  /** The key labelKey gave (a cleaned label no group holds). */
  key: string;
  /** The key it is to be read as: one of the known keys, or another label's key. */
  canonical: string;
  reason: string;
}

/**
 * Maps the distinct keys no synonym group holds onto canonical ones — the
 * step that needs a model. Called once per batch of distinct keys, never per
 * value: a 574-report corpus has a few thousand distinct labels against a few
 * hundred thousand cells.
 */
export interface LabelNormalizer {
  readonly name: string;
  normalize(keys: readonly string[]): Promise<LabelMapping[]>;
}

/** The normalizer that adds nothing: keys stay as cleaned. The default; also what tests use. */
export const identityNormalizer: LabelNormalizer = {
  name: 'identity',
  async normalize() {
    return [];
  },
};

/** At most this many keys go out in one model call. */
export const LABEL_BATCH = 200;

/** The prompt a model normalizer sends for one batch of keys. */
export function labelNormalizePrompt(keys: readonly string[]): ChatMessage[] {
  const known = [...LINE_ITEM_KEYS].join(', ');
  return [
    {
      role: 'system',
      content: `You map financial statement row labels onto canonical line-item keys. Known keys: ${known}.
For each input label answer with the known key it is the same line item as, or with null when none is the same line item (do not force a near match: "其他应付款" is not accounts_payable, "total other assets" is not total_assets). The label's language does not matter.
Respond with JSON only: {"mappings":[{"label": <input label, verbatim>, "key": <known key or null>}]}`,
    },
    { role: 'user', content: keys.map((k, i) => `${i + 1}. ${k}`).join('\n') },
  ];
}

/** The mappings a model's reply holds: only labels that were asked about, only known keys. */
export function parseLabelNormalizeReply(reply: unknown, keys: readonly string[]): LabelMapping[] {
  const asked = new Set(keys);
  const rows = (reply as { mappings?: unknown })?.mappings;
  if (!Array.isArray(rows)) return [];
  const out: LabelMapping[] = [];
  for (const r of rows) {
    const label = typeof r?.label === 'string' ? r.label : null;
    const key = typeof r?.key === 'string' ? r.key.trim() : null;
    if (!label || !key || !asked.has(label) || !LINE_ITEM_KEYS.has(key) || key === label) continue;
    out.push({ key: label, canonical: key, reason: 'model' });
  }
  return out;
}

/** A normalizer that asks a model, through `complete` (an LlmClient's completeJson, or a stub in tests). */
export function modelNormalizer(name: string, complete: (messages: ChatMessage[]) => Promise<unknown>): LabelNormalizer {
  return {
    name,
    async normalize(keys) {
      const out: LabelMapping[] = [];
      for (let i = 0; i < keys.length; i += LABEL_BATCH) {
        const batch = keys.slice(i, i + LABEL_BATCH);
        out.push(...parseLabelNormalizeReply(await complete(labelNormalizePrompt(batch)), batch));
      }
      return out;
    },
  };
}
