// 国民健康保険料 計算ロジック（純粋関数）
// Browser: <script> で読み込むとグローバル関数として使用可能
// Node:    require('./js/core/kokuho') で { calculateKokuho } を取得

// 子ども・子育て支援金分の賦課限度額の国基準（政令）。
// 出典: 国民健康保険法施行令 第29条の7 第5項 第10号（令和8年度新設・30,000円、2026-07-02 確認）
// 注意: 条例で国基準未満を定める自治体が実在する（例: shika 20,000円）ため、
// これは「データ欠落時の最後の手段」であり、正は各自治体 JSON の childcareLevy.cap。
const CHILDCARE_CAP_NATIONAL = 30000;

function calculateKokuho(input, data) {
  const { income, family, preschool, under18, care, salaryPensionCount, fixedAssetTax,
          reductionJudgmentIncome, members } = input;

  // 加入者ごとの所得（任意・2026-10-04 追加・TASKS X170-12）。
  //   members: [{ income: 前年の総所得金額等（基礎控除前）, careTarget: 40〜64歳なら true }, ...]
  // 所得割の基礎額は「加入者ごとに 所得 − 基礎控除（下限0）」の合計で、介護分の所得割は
  // careTarget の人の基礎額だけに掛ける（市原市の公式計算例で確認）。
  // members が無いときは従来どおり income 1本から基礎控除を1回だけ引く（既存ページ・API・テストの結果は不変）。
  // 均等割・平等割の人数（family / care / under18 / preschool）は members ではなく従来の入力を使う。
  const memberList = Array.isArray(members) && members.length > 0 ? members : null;

  // ① income=undefined 対策：未指定時は 0 として扱う
  // members があるときは各人の所得の合計（軽減判定の既定値にも使う）。
  const incomeSafe      = memberList
    ? memberList.reduce((s, m) => s + Math.max(m?.income || 0, 0), 0)
    : (income || 0);
  const familySafe      = Math.max(family || 0, 0);
  // ③ preschool / care が family を超えた場合は family に clamp
  const preschoolSafe   = Math.min(Math.max(preschool || 0, 0), familySafe);
  const careSafe        = Math.min(Math.max(care      || 0, 0), familySafe);

  // 軽減判定に使う所得。擬制世帯主がいる場合は household.js 側が
  // (加入者所得 + 世帯主所得) を計算してここに渡す。未指定時は income にフォールバック。
  const reductionBase = reductionJudgmentIncome ?? incomeSafe;

  // 資産割
  const assetLevyMedical = data.assetLevy ? Math.round(fixedAssetTax * (data.assetLevy.medical || 0)) : 0;
  const assetLevySupport = data.assetLevy ? Math.round(fixedAssetTax * (data.assetLevy.support || 0)) : 0;
  // 介護分は介護納付金課税被保険者（40〜64歳）がいる世帯だけに課す（所得割・均等割・平等割と同じ条件）。
  // 旧実装は care=0 の世帯にも介護分資産割を課していた（2026-10-01 修正）。
  const assetLevyCare    = data.assetLevy && careSafe > 0 ? Math.round(fixedAssetTax * (data.assetLevy.care    || 0)) : 0;
  const assetLevyChildcare = data.assetLevy ? Math.round(fixedAssetTax * (data.assetLevy.childcare || 0)) : 0;

  const memberBase = (m) => Math.max(Math.max(m?.income || 0, 0) - data.basicDeduction, 0);
  const baseIncome = memberList
    ? memberList.reduce((s, m) => s + memberBase(m), 0)
    : Math.max(incomeSafe - data.basicDeduction, 0);
  // 介護分の所得割の基礎額。members が無いときは従来どおり世帯の基礎額全部（簡易計算）。
  const careBaseIncome = memberList
    ? memberList.reduce((s, m) => s + (m?.careTarget ? memberBase(m) : 0), 0)
    : baseIncome;

  // 所得割
  const medicalIncome = Math.round(baseIncome * data.rate.medical);
  const supportIncome = Math.round(baseIncome * data.rate.support);
  const careIncome    = careSafe > 0 ? Math.round(careBaseIncome * data.rate.care) : 0;

  // 均等割
  const medicalPerCapita = familySafe * data.perCapita.medical;
  const supportPerCapita = familySafe * data.perCapita.support;
  const carePerCapita    = careSafe   * data.perCapita.care;

  // 平等割
  const medicalHousehold = data.household?.medical || 0;
  const supportHousehold = data.household?.support || 0;
  const careHousehold    = careSafe > 0 ? (data.household?.care || 0) : 0;

  // 未就学児軽減の計算は「軽減判定」で reductionRate が確定した後に行う。
  // 制度上、法定軽減（7/5/2割）が適用される世帯では「軽減後の」均等割額の5割を
  // 軽減するため、reductionRate に依存する。定義は下方（reductionRate 決定後）へ移動。

  // 学齢児軽減（未就学児を除く 18 歳未満の医療分・支援分均等割を減額）
  // 例: 昭島市の独自減免「未就学児を除く 18 歳未満の医療分・支援分均等割を 5割減額」
  // 対象人数 = under18 - 未就学児（負値防止のため max(0, ...)）。介護分には適用しない。
  // schoolReduction.enabled が true でない自治体は schoolReductionMedical/Support = 0 → 既存挙動完全維持。
  const u18Safe = Math.min(under18 || 0, familySafe);
  const schoolSafe = Math.max(u18Safe - preschoolSafe, 0);
  // 実際の減額計算は「軽減判定」で reductionRate が確定した後に行う（未就学児軽減と同じ）。

  // 軽減判定
  // ② salaryPensionCount > family 対策：family を上限として clamp
  const B = Math.max(Math.min(salaryPensionCount || 0, familySafe || 1), 1);
  const salaryPensionAdd = data.reduction?.salaryPensionAdd || 0;
  const extraForIncomeEarners = salaryPensionAdd * Math.max(0, B - 1);

  const sevenTenthsLimit =
    (data.reduction?.standards?.sevenTenths?.base || 0) +
    ((data.reduction?.standards?.sevenTenths?.perPersonAdd || 0) * family) +
    extraForIncomeEarners;

  const fiveTenthsLimit =
    (data.reduction?.standards?.fiveTenths?.base || 0) +
    ((data.reduction?.standards?.fiveTenths?.perPersonAdd || 0) * family) +
    extraForIncomeEarners;

  const twoTenthsLimit =
    (data.reduction?.standards?.twoTenths?.base || 0) +
    ((data.reduction?.standards?.twoTenths?.perPersonAdd || 0) * family) +
    extraForIncomeEarners;

  let reductionLabel = "軽減なし";
  let reductionRate  = 0;

  if (reductionBase <= sevenTenthsLimit) {
    reductionLabel = "7割軽減";
    reductionRate  = data.reduction?.ratios?.sevenTenths || 0;
  } else if (reductionBase <= fiveTenthsLimit) {
    reductionLabel = "5割軽減";
    reductionRate  = data.reduction?.ratios?.fiveTenths || 0;
  } else if (reductionBase <= twoTenthsLimit) {
    reductionLabel = "2割軽減";
    reductionRate  = data.reduction?.ratios?.twoTenths || 0;
  }

  // 未就学児軽減（均等割の医療分・支援分）
  // 制度: 法定軽減（7/5/2割）が適用される世帯では「軽減後の均等割額」の5割を軽減する。
  //   例) 7割軽減世帯 → 残り3割の5割(=1.5割)を軽減 → 合計8.5割軽減。
  // よって未就学児分の per-capita に (1 - reductionRate) を乗じた残額へ軽減率を適用する。
  // reductionRate=0（軽減なし）のときは (1-0)=1 で従来式と一致（後方互換）。
  const preschoolReductionMedical = Math.round(
    preschoolSafe * data.perCapita.medical * (1 - reductionRate) * (data.preschoolReduction?.medicalPerCapitaRate || 0)
  );
  const preschoolReductionSupport = Math.round(
    preschoolSafe * data.perCapita.support * (1 - reductionRate) * (data.preschoolReduction?.supportPerCapitaRate || 0)
  );
  const preschoolReduction = preschoolReductionMedical + preschoolReductionSupport;

  // 学齢児軽減（自治体独自）
  // 法定軽減（7/5/2割）が適用される世帯では「軽減後の均等割額」に対して独自減額率を掛ける。
  //   例) 7割軽減世帯 × 独自5割 → 残り3割の5割(=1.5割)を軽減 → 合計8.5割軽減。
  //   例) 7割軽減世帯 × 独自10割 → 残り3割を全部軽減 → 当該児の均等割は0円。
  // 乗算なので「法定が先か独自が先か」で結果は変わらない。
  // (1 - reductionRate) を掛けないと軽減率+独自率が100%を超え、他の被保険者分まで
  //   食いつぶして区分合計が0円に張り付く（旧実装の不具合）。
  const schoolReductionMedical = data.schoolReduction?.enabled ? Math.round(
    schoolSafe * data.perCapita.medical * (1 - reductionRate) * (data.schoolReduction?.medicalPerCapitaRate || 0)
  ) : 0;
  const schoolReductionSupport = data.schoolReduction?.enabled ? Math.round(
    schoolSafe * data.perCapita.support * (1 - reductionRate) * (data.schoolReduction?.supportPerCapitaRate || 0)
  ) : 0;
  const schoolReduction = schoolReductionMedical + schoolReductionSupport;

  // 子ども・子育て支援金分（R8新設・0なら無効）
  // childcareLevy（旧方式・under18Reduction/perCapitaAdult 対応）を優先、
  // なければ migration 後の data.childcare（フラット: rate/perCapita/household）を使う。
  const childcareCfg        = data.childcareLevy || data.childcare;
  const childcareRate       = childcareCfg?.rate      || 0;
  const childcarePerCapita  = childcareCfg?.perCapita || 0;
  const childcareHousehold  = childcareCfg?.household || 0;
  const childcareIncome     = childcareRate > 0 ? Math.round(baseIncome * childcareRate) : 0;

  // 均等割の計算
  // 新方式(perCapitaAdult あり):
  //   18歳以上 → perCapita + perCapitaAdult（例: 京都市 1,110 + 60 = 1,170円）
  //   18歳未満 → 0（under18Reductionで全額減額）
  // 旧方式(perCapitaAdult なし、under18Reduction: true):
  //   18歳以上 → perCapita のみ（例: 練馬区 1,873円）
  //   18歳未満 → 0
  const u18    = Math.min(under18 || 0, familySafe);
  const adults = familySafe - u18;
  let childcarePerCapitaTotal;
  if (childcareCfg?.perCapitaAdult !== undefined) {
    // perCapitaAdultScope で均等割の計算方式を切り替える（電話確認後にフラグを確定）
    //   "all_ages"    : 大人 = perCapita + perCapitaAdult、18歳未満 = 0
    //                     （「全員に perCapita 適用」ではない。18歳未満は下の adults 計算から除外される。
    //                       2026-08-30: この記述が実装と食い違っており、条例照合で誤読の原因になった）
    //   "adults_only" : 大人のみ perCapitaAdult、perCapita は 18歳未満向け名目額（全額減額で実質0）
    const scope = childcareCfg.perCapitaAdultScope;
    if (scope === undefined) {
      throw new Error(`[kokuho] ${data.citySlug}: perCapitaAdult が定義されていますが perCapitaAdultScope がありません。"all_ages" または "adults_only" を設定してください。`);
    }
    if (scope === 'adults_only') {
      childcarePerCapitaTotal = adults * (childcareCfg.perCapitaAdult || 0);
    } else {
      childcarePerCapitaTotal = adults * (childcarePerCapita + (childcareCfg.perCapitaAdult || 0));
    }
  } else {
    // 旧形式（perCapitaAdult 未定義）: 国制度上、子ども・子育て支援金分の均等割は
    // 18歳未満が全額軽減（10割減免）のため、デフォルトで 18歳未満を除外する。
    // （旧実装は under18Reduction: true 明示時のみ除外しており、フラグなしの
    //   旧形式 childcareLevy 1,449自治体で18歳未満からも徴収する計算誤りがあった）
    const under18Excluded = childcarePerCapita > 0 ? u18 : 0;
    childcarePerCapitaTotal = (family - under18Excluded) * childcarePerCapita;
  }
  const childcareHouseholdTotal = childcareRate > 0 ? childcareHousehold : 0;

  // 軽減額（均等割＋平等割に適用）
  const medicalReduction   = Math.round((medicalPerCapita  + medicalHousehold)             * reductionRate);
  const supportReduction   = Math.round((supportPerCapita  + supportHousehold)             * reductionRate);
  const careReduction      = Math.round((carePerCapita     + careHousehold)                * reductionRate);
  const childcareReduction = Math.round((childcarePerCapitaTotal + childcareHouseholdTotal) * reductionRate);

  // 区分別合計
  let medicalTotal   = medicalIncome  + medicalPerCapita        + medicalHousehold         + assetLevyMedical - preschoolReductionMedical - schoolReductionMedical - medicalReduction;
  let supportTotal   = supportIncome  + supportPerCapita        + supportHousehold         + assetLevySupport - preschoolReductionSupport - schoolReductionSupport - supportReduction;
  let careTotal      = careIncome     + carePerCapita           + careHousehold            + assetLevyCare    - careReduction;
  let childcareTotal = childcareIncome + childcarePerCapitaTotal + childcareHouseholdTotal + assetLevyChildcare - childcareReduction;

  medicalTotal   = Math.min(Math.max(medicalTotal,   0), data.caps.medical);
  supportTotal   = Math.min(Math.max(supportTotal,   0), data.caps.support);
  careTotal      = Math.min(Math.max(careTotal,      0), data.caps.care);
  // 支援金分の cap は自治体データが正。未定義なら国基準で代用するが、
  // 静かに落とさず警告する（cap 未定義は 2026-07-02 時点で 114 自治体）。
  let childcareCap = childcareCfg?.cap;
  if (childcareCap === undefined) {
    childcareCap = CHILDCARE_CAP_NATIONAL;
    if (childcareTotal > 0 && typeof console !== "undefined") {
      console.warn(`[kokuho] ${data.citySlug || "(citySlug不明)"}: childcareLevy.cap がデータ未定義のため国基準 ${CHILDCARE_CAP_NATIONAL} 円で代用（条例値の確認・データ整備が必要）`);
    }
  }
  childcareTotal = Math.min(Math.max(childcareTotal, 0), childcareCap);

  const total          = medicalTotal + supportTotal + careTotal + childcareTotal;
  const monthly        = Math.round(total / 12);
  const totalReduction = medicalReduction + supportReduction + careReduction + childcareReduction;
  const assetLevyTotal = assetLevyMedical + assetLevySupport + assetLevyCare + assetLevyChildcare;

  return {
    medicalTotal, supportTotal, careTotal, childcareTotal,
    total, monthly,
    preschoolReduction, schoolReduction, totalReduction,
    reductionLabel, assetLevyTotal,
  };
}

if (typeof module !== 'undefined') module.exports = { calculateKokuho };
