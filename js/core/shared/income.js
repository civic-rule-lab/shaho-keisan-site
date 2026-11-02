// 収入 → 所得 → 課税標準所得 への変換ユーティリティ
// 純粋関数のみ。Node.js / Browser 両対応。
//
// 税制バージョン:
//   calcSalaryIncome:    年度（前年分の所得）ごとの所得税法 別表第五（令和6年分＝55万／令和7年分＝65万／令和8年分以降＝74万）
//                        詳細と出典は calcSalaryIncome のコメント
//   calcPensionIncome:   令和2年以降の現行制度（変更なし）

'use strict';

// ─── 1. 給与所得控除後の給与所得 ──────────────────────────────────

/**
 * 給与収入から給与所得控除を差し引いた「給与所得」を返す。
 *
 * 給与収入 660万円未満は所得税法 別表第五（年末調整等のための給与所得控除後の給与等の金額の表）により、
 * 給与を「年調給与額」A（各階級の最低金額＝おおむね 4,000円刻みの下限）に置き換えてから計算する。
 * 連続式（収入×30%+8万 等）をそのまま当てると、4,000円刻みの途中で最大 3,999円ずれる（2026-10-29 全方向試算 C022・C023・C121）。
 * 個人住民税の給与所得も同じ（地方税法 第313条第3項により所得税法の例による）。
 *
 * 住民税・国保の「年度」N は前年 N−1 年分の所得で計算するので、年度から年分の表を選ぶ:
 *   令和7年度以前（令和6年分以前）: 最低保障 55万。1,619,000〜1,627,999円に 1,000・2,000円刻みの階級
 *   令和8年度（令和7年分）       : 最低保障 65万（令和7年度税制改正）。190万円から 4,000円刻み
 *   令和9年度以降（令和8年分以降）: 最低保障 69万＋特例5万＝74万（令和8年度税制改正・令和8・9年分）。
 *                                  2,191,000〜2,199,999円は固定値。220万円から 4,000円刻み
 *   ※令和10年分（令和11年度）以降は特例5万の扱いが未定のため、令和8年分の表で代用している［未確認］
 * 出典（各年分の「年末調整のしかた」の「電子計算機等による年末調整 1 給与所得控除後の給与等の金額の計算」・2026-10-29 確認）:
 *   令和6年分 https://www.nta.go.jp/publication/pamph/gensen/nencho2024/pdf/24.pdf
 *   令和7年分 https://www.nta.go.jp/publication/pamph/gensen/nencho2025/pdf/204.pdf
 *   令和8年分 https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/204.pdf
 *   令和8年分の表は data/national/shotokuzei-2026.json（所得税エンジン shotoku.js）と同じ値。
 *
 * @param {number} salary - 給与収入（円、年額）
 * @param {number} [fiscalYear=2026] - 個人住民税（国保）の年度。既定=令和8年度(2026)で後方互換。
 * @returns {number} 給与所得（円、整数）
 */
// 年調給与額 A の刻み: [下限, 上限(未満), 刻み, 刻みの基準]。範囲外は給与の総額のまま。
// 給与所得の式: [上限(未満), 種類, 値…]。'zero'=0 / 'minus'=A−値 / 'fixed'=値 / 'rate'=A×率+加算（A は刻みの倍数なので積は整数）
//   / 'rate90'=floor(A×90%)−110万 / 'cap'=A−195万
const SALARY_TABLE5 = {
  2024: { // 令和6年分（令和2〜6年分）
    bands: [[1_619_000, 1_620_000, 1_000, 1_619_000], [1_620_000, 1_624_000, 2_000, 1_620_000], [1_624_000, 6_600_000, 4_000, 1_624_000]],
    steps: [[551_000, 'zero'], [1_619_000, 'minus', 550_000], [1_620_000, 'rate', 0.6, 97_600], [1_622_000, 'rate', 0.6, 98_000],
            [1_624_000, 'rate', 0.6, 98_800], [1_628_000, 'rate', 0.6, 99_600], [1_800_000, 'rate', 0.6, 100_000]],
  },
  2025: { // 令和7年分
    bands: [[1_900_000, 6_600_000, 4_000, 1_900_000]],
    steps: [[651_000, 'zero'], [1_900_000, 'minus', 650_000]],
  },
  2026: { // 令和8年分（令和8・9年分）
    bands: [[2_200_000, 6_600_000, 4_000, 2_200_000]],
    steps: [[741_000, 'zero'], [2_191_000, 'minus', 740_000], [2_193_000, 'fixed', 1_451_000], [2_196_000, 'fixed', 1_453_000], [2_200_000, 'fixed', 1_456_000]],
  },
};
// 各年分に共通する上の区間（1,800,000円〜。令和7年分以降は手前の区間が先に当たるので 180万〜190万／220万は使われない）
const SALARY_TABLE5_COMMON = [[3_600_000, 'rate', 0.7, -80_000], [6_600_000, 'rate', 0.8, -440_000], [8_500_000, 'rate90'], [Infinity, 'cap']];

function _salaryIncomeYear(fiscalYear) {
  const fy = Number.isFinite(fiscalYear) ? fiscalYear : 2026;
  const incomeYear = fy - 1;
  return incomeYear <= 2024 ? 2024 : incomeYear === 2025 ? 2025 : 2026;
}

function calcSalaryIncome(salary, fiscalYear = 2026) {
  if (!Number.isFinite(salary) || salary <= 0) return 0;
  const s = Math.floor(salary);
  const T = SALARY_TABLE5[_salaryIncomeYear(fiscalYear)];

  // 年調給与額 A（660万円未満の各階級の最低金額）
  let a = s;
  for (const [lo, hi, unit, base] of T.bands) {
    if (s >= lo && s < hi) { a = s - ((s - base) % unit); break; }
  }

  for (const [limit, kind, v1, v2] of T.steps.concat(SALARY_TABLE5_COMMON)) {
    if (a >= limit) continue;
    switch (kind) {
      case 'zero':   return 0;
      case 'minus':  return a - v1;
      case 'fixed':  return v1;
      case 'rate':   return Math.round(a * v1) + v2;           // a は刻みの倍数で a×率 は整数（浮動小数の誤差だけ丸める）
      case 'rate90': return Math.floor(a * 9 / 10) - 1_100_000; // 1円未満切捨て（別表第五の注2）
      case 'cap':    return a - 1_950_000;
    }
  }
  return 0;
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
  // 公的年金等に係る雑所得以外の合計所得金額（otherIncome）が 1,000万円超なら控除が10万円、2,000万円超なら20万円少ない。
  //   所得税法 第35条第4項第2号・第3号（定額部分 40万→30万→20万・最低額 60万→50万→40万）、
  //   65歳以上は租税特別措置法 第41条の15の3第1項（最低額 110万→100万→90万）。[確認済 2026-10-30 e-Gov 法令API]
  //   収入に応じた部分（第1号ロ）は3区分で同じなので、差はどの年金額でもちょうど 10万・20万（2026-10-30 全方向試算 C025）。
  const other = Number.isFinite(otherIncome) ? otherIncome : 0;
  const reduction = other > 20_000_000 ? 200_000 : other > 10_000_000 ? 100_000 : 0;

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

  return Math.max(0, Math.floor(pension - (deduction - reduction)));
}

// ─── 2-2. 所得金額調整控除（給与所得と公的年金等に係る雑所得の両方がある人） ─────

/**
 * 給与所得と年金所得の両方がある人の所得金額調整控除の額を返す。給与所得から差し引く。
 *   控除額 = min(給与所得, 10万) + min(年金所得, 10万) − 10万（0 未満は 0）
 *   根拠: 租税特別措置法 第41条の3の11 第2項。住民税の総所得金額も所得税の計算の例による（地方税法 第313条第2項）。
 *   [確認済 2026-10-25 e-Gov 法令API]
 * 子・特別障害者がいて給与収入850万超の人の控除（同条 第1項）は calcIncomeAdjustmentDeduction1。
 *
 * @param {number} salaryIncome  - 給与所得控除後の給与等の金額（calcSalaryIncome の値）
 * @param {number} pensionIncome - 公的年金等に係る雑所得の金額（calcPensionIncome の値）
 * @returns {number} 控除額（円、0〜10万）
 */
function calcIncomeAdjustmentDeduction(salaryIncome, pensionIncome) {
  const s = Number.isFinite(salaryIncome)  ? Math.max(0, salaryIncome)  : 0;
  const p = Number.isFinite(pensionIncome) ? Math.max(0, pensionIncome) : 0;
  return Math.max(0, Math.min(s, 100_000) + Math.min(p, 100_000) - 100_000);
}

/**
 * 給与収入850万円超で、本人が特別障害者か、23歳未満の扶養親族・特別障害者である同一生計配偶者か扶養親族がいる人の
 * 所得金額調整控除の額を返す。給与所得から差し引く。
 *   控除額 = (給与収入（1,000万円超は1,000万円）− 850万円) × 10%（1円未満切上げ）
 *   根拠: 租税特別措置法 第41条の3の11 第1項・第3項（判定は12月31日の現況）。住民税も地方税法 第313条第2項で同じ。
 *   端数の切上げと「夫婦の双方に適用できる」は国税庁タックスアンサー No.1411。
 *   [確認済 2026-10-30 e-Gov 法令API・国税庁]
 * @param {number}  salary   - 給与等の収入金額（円）
 * @param {boolean} eligible - 上の要件（23歳未満の扶養親族など）に当たる
 * @returns {number} 控除額（円、0〜15万）
 */
function calcIncomeAdjustmentDeduction1(salary, eligible) {
  const s = Number.isFinite(salary) ? salary : 0;
  if (!eligible || s <= 8_500_000) return 0;
  return Math.ceil((Math.min(s, 10_000_000) - 8_500_000) / 10);
}

/**
 * 給与所得（所得金額調整控除の後）＋年金所得 を返す。
 * under23Dependent が真なら第1項の控除も引く（第2項は第1項を引いた残額から引く・同条第2項かっこ書き）。
 * @returns {number} 円、整数
 */
function calcSalaryPensionIncome(salary, pension, age, fiscalYear, otherIncome = 0, under23Dependent = false) {
  const salaryIncome  = calcSalaryIncome(salary || 0, fiscalYear);
  const adj1          = calcIncomeAdjustmentDeduction1(salary || 0, under23Dependent);
  // 年金以外の合計所得金額＝年金が無いものとして計算した合計所得（給与所得＋その他の所得。年金が無ければ第2項の控除は生じない）
  const other         = Number.isFinite(otherIncome) ? otherIncome : 0;
  const pensionIncome = calcPensionIncome(pension || 0, age, salaryIncome - adj1 + other);
  // 第2項の「給与所得控除後の給与等の金額」は第1項を引く前の額（同条第4項第5号）
  return salaryIncome - adj1 + pensionIncome - calcIncomeAdjustmentDeduction(salaryIncome, pensionIncome);
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
 * @param {boolean} [params.under23Dependent=false] - 所得金額調整控除 第1項の要件に当たる（calcIncomeAdjustmentDeduction1）
 * @returns {number} 総所得金額等（円、整数）
 */
function calcTaxableIncomeForKokuho(params) {
  const p = params || {};
  const other = Number.isFinite(p.otherIncome) ? p.otherIncome : 0;

  return Math.max(0, calcSalaryPensionIncome(p.salary, p.pension, p.age, p.fiscalYear, other, !!p.under23Dependent) + other);
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
  const otherJ = Number.isFinite(p.otherIncome) ? p.otherIncome : 0;
  const totalIncome =
    calcSalaryPensionIncome(p.salary, p.pension, p.age, p.fiscalYear, otherJ, !!p.under23Dependent) + otherJ;

  const deductions =
    (p.socialInsurance       || 0) +
    (p.spouseDeduction       || 0) +
    (p.dependentDeduction    || 0) +
    (p.disabilityDeduction   || 0) +
    (p.singleParentDeduction || 0) +
    (Number.isFinite(p.basicDeductionJumin) ? p.basicDeductionJumin : 430_000);

  return Math.max(0, Math.floor(totalIncome - deductions));
}

// ─── 国保の軽減判定：給与所得者等に当たるか ─────────────────────────────
// 給与収入が55万円を超える人、または公的年金等の収入が 65歳未満で60万円・65歳以上で110万円を超える人
//   （国民健康保険法施行令 第29条の7 第6項第1号）[確認済 2026-10-25 e-Gov 法令API・2026-08-01 施行時点]
function isKyuyoShotokushaTou(salary, pension, age) {
  if ((Number(salary) || 0) > 550_000) return true;
  const limit = (Number.isFinite(age) && age >= 65) ? 1_100_000 : 600_000;
  return (Number(pension) || 0) > limit;
}

// ─── 国保・後期高齢者医療の軽減判定：65歳以上の公的年金所得の特別控除（15万円） ─────
// 軽減判定の所得は、65歳以上（前年12月31日時点）の公的年金等に係る所得から15万円を差し引いた額で判定する
// （所得割の所得には差し引かない）。差し引く額はその人の年金所得が上限。
//   国保: 国民健康保険法施行令 附則第5条（第29条の7第6項第1号の読替え）[確認済 2026-10-24 e-Gov 法令API・2026-08-01 施行時点]
//   後期: kouki.js の reductionJudgmentIncome の注記・後期ページ（kouki-simple / kouki-income）と同じ扱い
// age は calcPensionIncome と同じ年齢（公的年金等控除の65歳判定に使う年齢）を渡す。
function calcKeigenPensionDeduction(pension, age) {
  if (!(Number.isFinite(age) && age >= 65)) return 0;
  return Math.min(150_000, calcPensionIncome(pension, age));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calcSalaryIncome, calcPensionIncome, calcIncomeAdjustmentDeduction, calcIncomeAdjustmentDeduction1, calcSalaryPensionIncome, calcTaxableIncomeForKokuho, calcTaxableIncomeForJumin, calcKeigenPensionDeduction, isKyuyoShotokushaTou };
}
