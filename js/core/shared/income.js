// 収入 → 所得 → 課税標準所得 への変換ユーティリティ
// 純粋関数のみ。Node.js / Browser 両対応。
//
// 税制バージョン:
//   calcSalaryIncome:    令和8年度（2026年度）以降の個人住民税ルール
//                        最低保障額 55万円 → 65万円（令和7年分所得に係る令和8年度分から適用）
//                        出典: 総務省「個人住民税について」令7.5.15
//   calcPensionIncome:   令和2年以降の現行制度（変更なし）

'use strict';

// ─── 1. 給与所得控除後の給与所得 ──────────────────────────────────

/**
 * 給与収入から給与所得控除を差し引いた「給与所得」を返す。
 *
 * 令和7年度税制改正（令和7年分所得に係る令和8年度分から）:
 *   - 最低保障額: 55万円 → 65万円
 *   - 162.5万〜180万円の区間（×40%-10万）を廃止
 *   - 190万円以下を一律65万円控除に統合（190万×30%+8万=65万で次区間と連続）
 *
 * 令和8年度税制改正（令和7年12月26日 大綱・R7.12閣議決定）:
 *   - 給与所得控除の最低保障を 65万→69万本則＋5万特例＝実効74万に引上げ。
 *   - 適用時期は所得税＝令和8・9年分／個人住民税＝令和9・10年度分。
 *   - 出典: 財務省『令和8年度税制改正の大綱』
 *     https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/20251226taikou.pdf
 *
 * @param {number} salary - 給与収入（円、年額）
 * @param {number} [fiscalYear=2026] - 個人住民税の年度。既定=令和8年度(2026)で後方互換。
 *   令和9年度(2027)以降は最低保障74万を適用。
 * @returns {number} 給与所得（円、整数）
 */
function calcSalaryIncome(salary, fiscalYear = 2026) {
  if (!Number.isFinite(salary) || salary <= 0) return 0;

  // 最低保障: 令和8年度=65万 / 令和9年度以降(+5万特例)=74万。
  // 最低保障は区間式に混ぜず max() のフロアとして扱う（切替点が自動移動）:
  //   65万→ salary 190万で 0.3s+8万 と連続 / 74万→ salary 220万で連続。
  const minGuarantee = fiscalYear >= 2027 ? 740_000 : 650_000;

  let deduction;
  if (salary <= 3_600_000) {
    deduction = Math.max(minGuarantee, salary * 0.3 + 80_000);
  } else if (salary <= 6_600_000) {
    deduction = salary * 0.2 + 440_000;
  } else if (salary <= 8_500_000) {
    deduction = salary * 0.1 + 1_100_000;
  } else {
    deduction = 1_950_000;
  }

  return Math.max(0, Math.floor(salary - deduction));
}

// ─── 2. 公的年金等控除後の年金所得 ────────────────────────────────

/**
 * 年金収入から公的年金等控除を差し引いた「年金所得」を返す。
 * 国税庁・令和2年以降の現行税制（年金以外の所得 ≦ 1,000万円を前提）。
 *
 * @param {number} pension       - 公的年金等の収入（円、年額）
 * @param {number} age           - 年齢（年末時点）。65歳以上で控除拡大。
 * @param {number} [otherIncome] - 将来の「他所得 1,000万超」分岐用フック。Phase 1 未使用。
 * @returns {number} 年金所得（円、整数）
 */
function calcPensionIncome(pension, age, otherIncome = 0) {
  if (!Number.isFinite(pension) || pension <= 0) return 0;

  const isSenior = Number.isFinite(age) && age >= 65;
  let deduction;

  if (isSenior) {
    if (pension <= 3_300_000) {
      deduction = 1_100_000;
    } else if (pension <= 4_100_000) {
      deduction = pension * 0.25 + 275_000;
    } else if (pension <= 7_700_000) {
      deduction = pension * 0.15 + 685_000;
    } else if (pension <= 10_000_000) {
      deduction = pension * 0.05 + 1_455_000;
    } else {
      deduction = 1_955_000;
    }
  } else {
    if (pension <= 1_300_000) {
      deduction = 600_000;
    } else if (pension <= 4_100_000) {
      deduction = pension * 0.25 + 275_000;
    } else if (pension <= 7_700_000) {
      deduction = pension * 0.15 + 685_000;
    } else if (pension <= 10_000_000) {
      deduction = pension * 0.05 + 1_455_000;
    } else {
      deduction = 1_955_000;
    }
  }

  return Math.max(0, Math.floor(pension - deduction));
}

// ─── 3. 国保用「総所得金額等」（基礎控除43万を引く前） ──────────────

/**
 * calculateKokuho() の inputs.income にそのまま渡せる値を返す。
 * 国保は旧ただし書き方式：所得控除（社保・扶養等）は適用しない。
 * 基礎控除43万円は kokuho.js 側で差し引くので、ここでは引かない。
 *
 * @param {Object} params
 * @param {number} [params.salary=0]      - 給与収入（円）
 * @param {number} [params.pension=0]     - 年金収入（円）
 * @param {number} [params.age]           - 年齢（年金控除分岐用）
 * @param {number} [params.otherIncome=0] - 事業・不動産等の所得金額（所得換算済）
 * @returns {number} 総所得金額等（円、整数）
 */
function calcTaxableIncomeForKokuho(params) {
  const p = params || {};
  const salaryIncome  = calcSalaryIncome(p.salary || 0, p.fiscalYear);
  const pensionIncome = calcPensionIncome(p.pension || 0, p.age);
  const other         = Number.isFinite(p.otherIncome) ? p.otherIncome : 0;

  return Math.max(0, salaryIncome + pensionIncome + other);
}

// ─── 4. 住民税用課税所得（Phase 1 後半向けスケルトン） ───────────────

/**
 * 住民税の課税所得（所得割算定基礎）を返す。
 * Phase 1 では骨組みのみ。各控除の詳細実装は jumin.js 側で拡張する。
 *
 * @param {Object} params
 * @param {number} [params.salary=0]
 * @param {number} [params.pension=0]
 * @param {number} [params.age]
 * @param {number} [params.otherIncome=0]
 * @param {number} [params.socialInsurance=0]       - 社会保険料控除（実額）
 * @param {number} [params.spouseDeduction=0]       - 配偶者控除
 * @param {number} [params.dependentDeduction=0]    - 扶養控除合計
 * @param {number} [params.disabilityDeduction=0]   - 障害者控除
 * @param {number} [params.singleParentDeduction=0] - ひとり親・寡婦控除
 * @param {number} [params.basicDeductionJumin]     - 住民税基礎控除（デフォルト43万）
 * @returns {number} 課税所得（円、整数）
 */
function calcTaxableIncomeForJumin(params) {
  const p = params || {};
  const totalIncome =
    calcSalaryIncome(p.salary || 0, p.fiscalYear) +
    calcPensionIncome(p.pension || 0, p.age) +
    (Number.isFinite(p.otherIncome) ? p.otherIncome : 0);

  const deductions =
    (p.socialInsurance       || 0) +
    (p.spouseDeduction       || 0) +
    (p.dependentDeduction    || 0) +
    (p.disabilityDeduction   || 0) +
    (p.singleParentDeduction || 0) +
    (Number.isFinite(p.basicDeductionJumin) ? p.basicDeductionJumin : 430_000);

  return Math.max(0, Math.floor(totalIncome - deductions));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calcSalaryIncome, calcPensionIncome, calcTaxableIncomeForKokuho, calcTaxableIncomeForJumin };
}
