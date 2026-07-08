// 社会保険料計算エンジン（協会けんぽ健保・介護・子育て支援金・厚生年金・雇用保険）令和8年度(2026)
// 制度計算ファミリー / shaho-keisan
// 一次ソース: 協会けんぽR8料額表(kyoukaikenpo.or.jp) / 厚労省R8雇用保険料率(mhlw.go.jp) / 年金機構(nenkin.go.jp)。
// 設計書 shaho-design.md §2 準拠。実行: node js/core/shaho.js → 自己テスト結果を表示
//
// 設計方針（kokuho/hoiku と同型）:
//   ・純粋関数。入力→出力のみ、DOM/fetch非依存。data は呼び出し側が渡す（loadData()も同梱）。
//   ・すべての料率は「対象月(targetMonth, YYYY-MM)」で期間解決する。納付月ではない。
//   ・対象月に合致する期間データが無ければ暗黙フォールバックせず throw（「表示R8・計算R7」型事故の防止）。
//   ・標準報酬月額は standard-monthly.json の explicitBoundaries（公式料額表の報酬月額レンジ）で判定。中点則は使わない。
//   ・折半額（表の「折半額」欄）は丸めず返す＝公式表と一致。給与控除時の50銭ルールは別途 roundEmployeeDeduct で提供。
//
// [確認済] 等級境界・県別料率・雇用保険率・厚年率・賞与上限・端数処理は一次ソースで検証済（2026-07-07）。
// [未確認・推測] 支援金R9以降の率は未公表（kenpo-2026.json futureSchedule 参照）。対象月が該当すれば throw する。

'use strict';

// Node/ブラウザ両対応（UMD）。fs/path は Node の loadData 専用＝ブラウザでは null（ブラウザは fetch 結果を渡す）。
const _isNode = (typeof require === 'function' && typeof module !== 'undefined' && module.exports);
const fs = _isNode ? require('fs') : null;
const path = _isNode ? require('path') : null;

// ---- 定数 ---------------------------------------------------------------
const KOSEI_FLOOR = 88000;   // 厚年 標準報酬月額の下限（=健保4等級/厚年1等級）
const SEN_HALF = 0.5;        // 50銭（端数処理の境界）

// ---- ユーティリティ ------------------------------------------------------

// "YYYY-MM" → 通し月数（比較用）。不正はthrow。
function monthIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) throw new Error(`targetMonth は "YYYY-MM" 形式が必要: ${ym}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`targetMonth の月が不正: ${ym}`);
  return y * 12 + (mo - 1);
}

// targetMonth が [validFrom, validTo] に入るか（validTo=null は無期限）
function inPeriod(targetMonth, validFrom, validTo) {
  const t = monthIndex(targetMonth);
  if (validFrom && t < monthIndex(validFrom)) return false;
  if (validTo && t > monthIndex(validTo)) return false;
  return true;
}

// 給与控除時の端数処理①: 被保険者負担分の端数が50銭以下=切捨、50銭超=切上（公式料額表脚注①）
function roundEmployeeDeduct(halfYen) {
  const whole = Math.floor(halfYen + 1e-9);
  const sen = halfYen - whole;
  return sen > SEN_HALF + 1e-9 ? whole + 1 : whole;
}

// ---- 標準報酬月額の決定 --------------------------------------------------

// 健保等級（1〜50）を報酬月額から判定。explicitBoundaries を正とする。
function kenpoGrade(monthlySalary, standard) {
  const B = standard && standard.explicitBoundaries;
  if (!Array.isArray(B) || B.length === 0) {
    throw new Error('standard-monthly.json explicitBoundaries が未転記（本番投入禁止）');
  }
  for (const b of B) {
    const okLo = b.min === null || monthlySalary >= b.min;
    const okHi = b.max === null || monthlySalary < b.max;
    if (okLo && okHi) return b;
  }
  throw new Error(`報酬月額 ${monthlySalary} に該当する健保等級なし`);
}

// 厚年の標準報酬月額。健保の標準額を [下限88,000, 対象月の上限cap] にクランプする。
// cap は kosei-nenkin.json capSchedule を対象月で解決（9月改定＝年度途中で変わる）。
function koseiStandard(kenpoStandardMonthly, targetMonth, kosei) {
  const sched = (kosei && kosei.capSchedule) || [];
  const hit = sched.find((s) => inPeriod(targetMonth, s.validFrom, s.validTo));
  if (!hit) {
    throw new Error(`厚年上限(capSchedule)が対象月 ${targetMonth} に未定義（フォールバック禁止）`);
  }
  const floor = (kosei && kosei.floor) || KOSEI_FLOOR;
  return { standard: Math.min(Math.max(kenpoStandardMonthly, floor), hit.cap), cap: hit.cap };
}

// ---- 健康保険 provider 解決（拡張シーム・shaho-design.md §7-6/§7-8） -------
// input.healthProvider = "kyoukai"(既定) | "senpo" | "kumiai"
// 協会けんぽ・船員保険を実装。組合健保は同一インターフェースの予約（未実装は throw）。
// prefSlug 必須チェックは "kyoukai" 内に置く（船員=全国一律で prefSlug 不要のため）。
//
// 正規化戻り値（provider 中立コントラクト。本人負担は率÷2でなく明示の employeeRate で解決）:
//   { provider, splitModel:'half'|'explicit',
//     healthRate, healthEmployeeRate,               // 全額率 と 本人負担率
//     careApplies, careRate, careEmployeeRate,
//     shienkinApplies, shienkinRate, shienkinEmployeeRate,
//     employerOnly:[{key,rate,note}],               // 船員 災害保険料率など（本人負担ゼロ）
//     meta }
// ⚠️ 船員は 疾病 本人 4.95%（総率÷2ではない）＋ 災害は本人負担なし ＝「÷2」ロジック不可。
//    そのため provider ごとに employeeRate を明示し、メイン側は half でなく employeeRate で本人負担を出す。
function resolveHealth(input, data) {
  const provider = input.healthProvider || 'kyoukai';
  const { targetMonth, prefSlug, age } = input;
  const { kenpo, senpo } = data;
  const ageKnown = typeof age === 'number';
  const isCareAge = ageKnown && age >= 40 && age <= 64;
  // 介護が非適用のとき、その理由を明示（age未指定と40歳未満・65歳以上を区別＝Fable5軽微①）
  const careReasonFor = (applies, periodIn) => {
    if (applies) return null;
    if (!ageKnown) return 'age-unknown（年齢未指定＝介護第2号の判定不可）';
    if (age < 40) return 'under-40（介護第2号は40歳から）';
    if (age > 64) return 'over-64（65歳以上は介護第1号＝給与天引きの対象外）';
    if (!periodIn) return 'out-of-period（対象月が介護料率の適用期間外）';
    return 'not-applicable';
  };

  if (provider === 'kyoukai') {
    if (!prefSlug) throw new Error('prefSlug（都道府県）は必須（協会けんぽ）');
    if (!inPeriod(targetMonth, kenpo.validFrom, kenpo.validTo)) {
      throw new Error(`健保料率が対象月 ${targetMonth} に未定義（フォールバック禁止・${kenpo.era || ''}データのみ）`);
    }
    const pref = kenpo.prefRates.find((p) => p.prefSlug === prefSlug);
    if (!pref) throw new Error(`prefSlug '${prefSlug}' が kenpo データに無い`);

    // 介護保険第2号（40〜64歳、対象月で解決）
    const careInPeriod = inPeriod(targetMonth, kenpo.careRate.validFrom, kenpo.careRate.validTo);
    const careApplies = isCareAge && careInPeriod;
    const careRate = careApplies ? kenpo.careRate.rate : 0;
    const careReason = careReasonFor(careApplies, careInPeriod);

    // 子ども・子育て支援金（4月分〜）。validFrom前=0（制度上まだ適用なし）／
    // validTo超=throw（率未公表の将来期間で暗黙0にしない＝「表示R9・支援金0」型事故の防止）
    const sh = kenpo.shienkinRate;
    if (sh.validTo && monthIndex(targetMonth) > monthIndex(sh.validTo)) {
      throw new Error(`子育て支援金率が対象月 ${targetMonth} に未定義（validTo=${sh.validTo}・率未公表＝フォールバック禁止）`);
    }
    const shienkinApplies = inPeriod(targetMonth, sh.validFrom, sh.validTo);
    const shienkinRate = shienkinApplies ? sh.rate : 0;

    return {
      provider, splitModel: 'half',
      healthRate: pref.rate, healthEmployeeRate: pref.rate / 2,
      careApplies, careRate, careEmployeeRate: careRate / 2, careReason,
      shienkinApplies, shienkinRate, shienkinEmployeeRate: shienkinRate / 2,
      employerOnly: [],
      meta: {
        provider, prefSlug, prefName: pref.prefName || null,
        healthRate: pref.rate, era: kenpo.era || null,
        validFrom: kenpo.validFrom, validTo: kenpo.validTo,
        source: (kenpo.source && kenpo.source.url) || null,
        verifiedAt: (kenpo.source && kenpo.source.verifiedAt) || null,
      },
    };
  }

  if (provider === 'senpo') {
    // 船員保険（全国一律・prefSlug 不要）。在職船員（zaishoku）を実装。
    // 疾病任意継続（ninkei・全額自己負担・29等級）は将来のサブモードとして予約。
    if (!senpo) throw new Error('senpo データ未読込（senpo-2026.json）。healthProvider:"senpo" には senpo データが必須');
    const z = senpo.zaishoku;
    if (!z) throw new Error('senpo.zaishoku がデータに無い');
    if (!inPeriod(targetMonth, z.validFrom, z.validTo)) {
      throw new Error(`船員 疾病保険料率が対象月 ${targetMonth} に未定義（フォールバック禁止・${senpo.era || ''}）`);
    }
    // 疾病: 全額 total（船主＋被保険者）。本人負担は軽減後 4.95%（総率÷2ではない）。
    const healthRate = z.shippei.total;               // 0.10（全額）
    const healthEmployeeRate = z.shippei.employee;    // 0.0495（本人・軽減後）

    // 介護第2号（40〜64・折半）。船員は senpo.care（R8=1.76%・本人0.88%）。
    const careRow = senpo.care;
    const careInPeriod = inPeriod(targetMonth, careRow.validFrom, careRow.validTo);
    const careApplies = isCareAge && careInPeriod;
    const careRate = careApplies ? careRow.rate : 0;
    const careEmployeeRate = careApplies ? careRow.employee : 0;
    const careReason = careReasonFor(careApplies, careInPeriod);

    // 子ども・子育て支援金（4月分〜・折半）。将来期間で率未公表なら throw（協会けんぽと同思想）。
    const shRow = senpo.shienkin;
    if (shRow.validTo && monthIndex(targetMonth) > monthIndex(shRow.validTo)) {
      throw new Error(`船員 子育て支援金率が対象月 ${targetMonth} に未定義（validTo=${shRow.validTo}・率未公表＝フォールバック禁止）`);
    }
    const shienkinApplies = inPeriod(targetMonth, shRow.validFrom, shRow.validTo);
    const shienkinRate = shienkinApplies ? shRow.rate : 0;
    const shienkinEmployeeRate = shienkinApplies ? shRow.employee : 0;

    // 災害保健福祉保険料率：全額船主負担・本人負担なし（employerOnly として surface）
    const saigai = senpo.zaishoku.saigaiHokenFukushi;

    return {
      provider, splitModel: 'explicit',
      healthRate, healthEmployeeRate,
      careApplies, careRate, careEmployeeRate, careReason,
      shienkinApplies, shienkinRate, shienkinEmployeeRate,
      employerOnly: [
        { key: 'saigaiHokenFukushi', rate: saigai.total, employeeRate: 0,
          note: '災害保健福祉保険料率＝全額船主負担・被保険者負担なし' },
      ],
      meta: {
        provider, prefSlug: null, prefName: null,
        healthRate, healthEmployeeRate,
        generalRate: z.generalRate, // 一般保険料率 11.05%（疾病10.00＋災害1.05・参考）
        saigaiRate: saigai.total,
        era: senpo.era || null,
        validFrom: z.validFrom, validTo: z.validTo,
        source: (senpo.source && (senpo.source.ratePage || senpo.source.zaishokuLeaflet)) || null,
        verifiedAt: (senpo.source && senpo.source.verifiedAt) || null,
        note: '船員（在職）。疾病 本人4.95%＝軽減後（総率÷2ではない）／災害は本人負担なし',
      },
    };
  }

  if (provider === 'kumiai') {
    throw new Error(`healthProvider 'kumiai' は未実装（組合健保・料率は組合ごと＝一元ソースなし。拡張シーム予約・shaho-design.md §7-3/§7-6）`);
  }
  throw new Error(`healthProvider '${provider}' は不明（"kyoukai"|"senpo"|"kumiai" のいずれか）`);
}

// ---- メイン --------------------------------------------------------------
//
// calculateShaho(input, data) → result
// input = { monthlySalary, targetMonth:"2026-07", prefSlug, age, koyoCategory, healthProvider?, bonus?, bonusYearToDate? }
// data  = { kenpo, kosei, koyo, standard }
//
function calculateShaho(input, data) {
  if (!input) throw new Error('calculateShaho: input がありません');
  if (!data) throw new Error('calculateShaho: data がありません');
  const { monthlySalary, targetMonth, prefSlug, age } = input;
  const koyoCategory = input.koyoCategory || 'ippan';

  if (typeof monthlySalary !== 'number' || monthlySalary < 0) {
    throw new Error('monthlySalary（報酬月額）が不正');
  }
  if (!targetMonth) throw new Error('targetMonth（対象月）は必須（フォールバック禁止）');

  const { kenpo, kosei, koyo, standard } = data;

  // --- 健康保険（provider抽象・拡張シーム §7-6）。対象月で期間解決。prefSlug必須はprovider内 ---
  const healthResolved = resolveHealth(input, data);
  const {
    provider: healthProvider, splitModel,
    healthRate, healthEmployeeRate,
    careApplies, careRate, careEmployeeRate, careReason,
    shienkinApplies, shienkinRate, shienkinEmployeeRate,
    employerOnly,
  } = healthResolved;

  // 介護・支援金の適用期間メタ（provider別ソース。kyoukai=kenpo / senpo=senpo）
  const careMeta = healthProvider === 'senpo' ? data.senpo.care : kenpo.careRate;
  const shienkinMeta = healthProvider === 'senpo' ? data.senpo.shienkin : kenpo.shienkinRate;

  // --- 標準報酬月額 ---
  const kGrade = kenpoGrade(monthlySalary, standard);
  const kStd = kGrade.standardMonthly;
  const { standard: nStd, cap: nCap } = koseiStandard(kStd, targetMonth, kosei);

  // --- 厚年率（対象月で解決） ---
  if (!inPeriod(targetMonth, kosei.rate.validFrom, kosei.rate.validTo)) {
    throw new Error(`厚年料率が対象月 ${targetMonth} に未定義`);
  }
  const koseiRate = kosei.rate.value;

  // --- 各保険料（全額・折半額・本人負担）。折半額は丸めない＝公式表と一致 ---
  // .half = full/2（協会けんぽは本人負担と一致・公式「折半額」欄）／
  // .employee = 本人負担額（employeeRate ベース。船員は 折半≠本人負担 のため .half と乖離しうる）
  const half = (x) => x / 2;
  const health = { rate: healthRate, full: kStd * healthRate };
  health.half = half(health.full);
  health.employee = kStd * healthEmployeeRate;
  health.employer = health.full - health.employee;

  const care = { applies: careApplies, rate: careRate, full: kStd * careRate, reason: careReason };
  care.half = half(care.full);
  care.employee = kStd * careEmployeeRate;
  care.employer = care.full - care.employee;

  // PDFの「介護保険第2号に該当する場合」列 = (健保率+介護率) 合算
  const healthWithCare = { rate: healthRate + careRate, full: kStd * (healthRate + careRate) };
  healthWithCare.half = half(healthWithCare.full);
  healthWithCare.employee = health.employee + care.employee;

  const shienkin = { applies: shienkinApplies, rate: shienkinRate, full: kStd * shienkinRate };
  shienkin.half = half(shienkin.full);
  shienkin.employee = kStd * shienkinEmployeeRate;
  shienkin.employer = shienkin.full - shienkin.employee;

  const koseiNenkin = { rate: koseiRate, standardMonthly: nStd, cap: nCap, full: nStd * koseiRate };
  koseiNenkin.half = half(koseiNenkin.full);
  koseiNenkin.employee = koseiNenkin.half; // 厚年は折半（provider共通）

  // 船員 災害保険料率等（本人負担ゼロ・全額船主）。UI/監査用に金額化して surface。
  const employerOnlyItems = (employerOnly || []).map((e) => ({
    key: e.key, rate: e.rate, full: kStd * e.rate, employee: 0, note: e.note,
  }));

  // --- 雇用保険（賃金総額ベース。標準報酬ではない） ---
  const cat = koyo.categories.find((c) => c.key === koyoCategory);
  if (!cat) throw new Error(`koyoCategory '${koyoCategory}' が koyo データに無い`);
  // 雇用保険は4月分〜適用（健保の3月分適用と1ヶ月ずれる）。適用期間外は「未計算」と明示（暗黙0ではない）。
  const koyoInPeriod = inPeriod(targetMonth, koyo.validFrom, koyo.validTo);
  const koyoIns = koyoInPeriod
    ? {
        applies: true,
        category: koyoCategory,
        employeeRate: cat.employee,
        employee: monthlySalary * cat.employee, // 賃金総額×労働者負担率（ここでは報酬月額を賃金総額とみなす）
        base: 'wage-total',
        note: '雇用保険は標準報酬ではなく賃金総額ベース。ここでは報酬月額を賃金総額とみなして計算',
      }
    : {
        applies: false,
        category: koyoCategory,
        employee: 0,
        reason: `対象月 ${targetMonth} は雇用保険R8料率(${koyo.validFrom}〜)の適用期間外`,
        displayHint: '未計算', // UI要件（§7-7低）: 暗黙0でなく「未計算」と表示（2026-03分は雇用保険が applies:false）
      };

  // --- 被保険者（本人）負担の月額合計 ---
  // 健保（介護込みなら+介護）＋支援金＋厚年＋雇用 の本人負担を合算。
  // 協会けんぽは .employee===.half（無回帰）／船員は .employee（軽減後4.95%等）で正しく算出。
  const healthEmployeeForSum = careApplies
    ? health.employee + care.employee   // = healthWithCare.employee
    : health.employee;
  const employeeRawTotal =
    healthEmployeeForSum + shienkin.employee + koseiNenkin.employee + koyoIns.employee;
  // 給与控除時の50銭ルールを各社会保険料の本人負担額に適用（雇用保険は円未満切捨が一般的だが本人負担は事業主計算に委ねる）
  const employeeRounded =
    roundEmployeeDeduct(healthEmployeeForSum) +
    roundEmployeeDeduct(shienkin.employee) +
    roundEmployeeDeduct(koseiNenkin.employee);

  const result = {
    input: { monthlySalary, targetMonth, prefSlug, age: age ?? null, koyoCategory, healthProvider },
    healthProvider, splitModel, // 'half'(協会けんぽ=本人負担は折半) | 'explicit'(船員=本人負担率が別)
    // grade/standardMonthly は provider中立名 health を正・kenpo は後方互換エイリアス（§7-7低）
    // koseiCapped=上限クランプ／koseiFloored=下限フロア を区別（Fable5軽微②：旧koseiCappedは下限時もtrueで誤解）
    grade: {
      health: kGrade.grade, kenpo: kGrade.grade,
      koseiCapped: nStd < kStd,     // 厚年 上限（cap）に当たった
      koseiFloored: nStd > kStd,    // 厚年 下限（floor 88,000）に当たった
      koseiAdjusted: nStd !== kStd, // どちらかで調整された（旧 koseiCapped 相当）
    },
    standardMonthly: { health: kStd, kenpo: kStd, koseiNenkin: nStd },
    health, care, healthWithCare, shienkin, koseiNenkin, koyo: koyoIns,
    employerOnly: employerOnlyItems, // 船員 災害保険料率など（本人負担ゼロ・全額船主）。協会けんぽは空配列
    employee: {
      socialInsuranceRaw: employeeRawTotal - koyoIns.employee, // 健保系＋厚年（折半・未丸め）
      socialInsuranceRounded: employeeRounded,                 // 50銭ルール適用後
      koyo: koyoIns.employee,
      note: '折半額は公式表と一致（未丸め）。socialInsuranceRounded は給与控除時の50銭ルール①適用後',
      roundingAssumption: '[未確認・推測] 50銭ルールを「健保(介護込)／支援金／厚年」の3区分で別建て丸め。支援金を健保と合算して丸めるのが給与実務の正か（区分の取り方）は公式FAQで要確定。丸め単位で数円ずれ得る',
    },
    // 適用期間・出典・更新日（各JSONから機械転記）。UI・生成・監査はこの meta を結線面とする ---
    meta: {
      targetMonth,
      generatedBy: 'shaho.js',
      health: healthResolved.meta,
      splitModel,
      care: {
        applies: careApplies, rate: careRate, employeeRate: careEmployeeRate, reason: careReason,
        validFrom: careMeta.validFrom, validTo: careMeta.validTo,
      },
      shienkin: {
        applies: shienkinApplies, rate: shienkinRate, employeeRate: shienkinEmployeeRate,
        validFrom: shienkinMeta.validFrom, validTo: shienkinMeta.validTo,
      },
      koseiNenkin: {
        rate: koseiRate, cap: nCap,
        validFrom: kosei.rate.validFrom, validTo: kosei.rate.validTo,
        source: (kosei.source && kosei.source.url) || null,
        verifiedAt: (kosei.source && kosei.source.verifiedAt) || null,
      },
      koyo: {
        applies: koyoIns.applies, category: koyoCategory,
        validFrom: koyo.validFrom, validTo: koyo.validTo,
        source: (koyo.source && koyo.source.url) || null,
        verifiedAt: (koyo.source && koyo.source.verifiedAt) || null,
        // 船員は雇用保険の区分を一般率で流用中＝[要最終確認]。status を surface（暗黙に確定扱いしない）
        confirmation: healthProvider === 'senpo'
          ? ((data.senpo && data.senpo.koyo && data.senpo.koyo.status) || 'unconfirmed')
          : 'confirmed',
        confirmationNote: healthProvider === 'senpo'
          ? '船員の雇用保険区分は koyo 一般率を流用見込み。senpo-2026.json koyo.status 参照＝[要最終確認]'
          : null,
      },
    },
  };

  // --- 賞与（任意） ---
  if (typeof input.bonus === 'number' && input.bonus > 0) {
    // 健保系 標準賞与額の年度上限（[確認済] 573万。provider別ソース：協会けんぽ=standard.kenpo.bonusCap／船員=senpo.bonusCap）
    const healthYearCapYen = healthProvider === 'senpo'
      ? ((data.senpo && data.senpo.bonusCap && data.senpo.bonusCap.senpoCareShienkinYearYen) || 5730000)
      : ((standard && standard.kenpo && standard.kenpo.bonusCap && standard.kenpo.bonusCap.fiscalYearTotal) || 5730000);
    result.bonus = calcBonus(input.bonus, {
      healthRate, careRate, shienkinRate, koseiRate,
      healthEmployeeRate, careEmployeeRate, shienkinEmployeeRate, // 本人負担率（船員は≠半分）
      koyoApplies: koyoIns.applies,
      koyoEmployeeRate: koyoIns.applies ? koyoIns.employeeRate : 0,
    }, { kenpo, kosei, healthYearCapYen, bonusYearToDate: input.bonusYearToDate });
  }

  return result;
}

// 賞与の保険料。標準賞与額=1,000円未満切捨（健保系・厚年）。
// 上限[確認済]: 厚年=1回150万／健保系（健保・介護・支援金）=年度累計573万（4/1〜翌3/31）。
// 健保系の年度上限は bonusYearToDate（累計）で残枠を出す。未指定時は「この賞与が年度唯一」とみなす保守上限
//   min(標準賞与額, 573万) を適用（単発で573万超は必ず超過＝上限適用は常に正しい方向）。
function calcBonus(bonus, rates, data) {
  data = data || {};
  const standardBonus = Math.floor(bonus / 1000) * 1000; // 1,000円未満切捨（健保系・厚年の標準賞与額）
  const koseiCap = (data.kosei && data.kosei.bonusCap && data.kosei.bonusCap.monthlyBonusCap) || 1500000;
  const koseiBonusBase = Math.min(standardBonus, koseiCap);
  const half = (x) => x / 2;

  // 雇用保険（賞与額×労働者負担率・上限なし）。適用期間外は未計算（暗黙0ではない）
  const koyoApplies = !!rates.koyoApplies;
  const koyoEmployee = koyoApplies ? bonus * (rates.koyoEmployeeRate || 0) : 0;

  // 健保系 年度累計上限（573万）。bonusYearToDate があれば残枠、無ければ年度唯一とみなす保守上限。
  const healthYearCapYen = (typeof data.healthYearCapYen === 'number') ? data.healthYearCapYen : 5730000;
  const bonusYearToDate =
    (typeof data.bonusYearToDate === 'number' && data.bonusYearToDate >= 0) ? data.bonusYearToDate : null;
  const remainingCap = bonusYearToDate === null
    ? healthYearCapYen                                   // 累計未提供＝この賞与が年度唯一とみなす
    : Math.max(0, healthYearCapYen - bonusYearToDate);   // 累計提供＝残枠
  const healthBonusBase = Math.min(standardBonus, remainingCap); // 健保・介護・支援金の課税標準
  const healthCapApplied = standardBonus > healthBonusBase;

  // 本人負担率（未指定なら折半＝率/2にフォールバック＝協会けんぽ無回帰）
  const heRate = (typeof rates.healthEmployeeRate === 'number') ? rates.healthEmployeeRate : rates.healthRate / 2;
  const caRate = (typeof rates.careEmployeeRate === 'number') ? rates.careEmployeeRate : rates.careRate / 2;
  const shRate = (typeof rates.shienkinEmployeeRate === 'number') ? rates.shienkinEmployeeRate : rates.shienkinRate / 2;

  return {
    standardBonus,
    koseiCapApplied: standardBonus > koseiCap,
    // 健保系は healthBonusBase（573万上限適用後）を課税標準にする
    health: { base: healthBonusBase, half: half(healthBonusBase * rates.healthRate), employee: healthBonusBase * heRate },
    care: { base: healthBonusBase, half: half(healthBonusBase * rates.careRate), employee: healthBonusBase * caRate },
    shienkin: { base: healthBonusBase, half: half(healthBonusBase * rates.shienkinRate), employee: healthBonusBase * shRate },
    koseiNenkin: { base: koseiBonusBase, half: half(koseiBonusBase * rates.koseiRate), employee: half(koseiBonusBase * rates.koseiRate) },
    koyo: koyoApplies
      ? { applies: true, employeeRate: rates.koyoEmployeeRate, employee: koyoEmployee, base: 'bonus-gross',
          note: '賞与額×労働者負担率（標準賞与額ではない・上限なし）' }
      : { applies: false, employee: 0, note: '対象月が雇用保険の適用期間外＝賞与の雇用保険は未計算' },
    healthYearCap: {
      capYen: healthYearCapYen, applied: healthCapApplied,
      bonusYearToDate, remainingCap, healthBonusBase, status: 'verified',
      note: bonusYearToDate === null
        ? '健保系 年度上限573万[確認済]を単発賞与に適用（この賞与が年度唯一とみなす保守上限）。複数回賞与は bonusYearToDate に累計を渡すと残枠で計算'
        : '健保系 年度上限573万[確認済]。bonusYearToDate（累計）から残枠を算出して適用',
    },
    note: '厚年は1回150万上限[確認済]。雇用保険は賞与額ベース・上限なし。健保系は年度573万上限[確認済]を適用（累計は bonusYearToDate で精緻化）',
  };
}

// ==== /hikaku/（任意継続 vs 国保）結線 ====================================
// 片方向の設計（shaho-design.md §7-6/§7-7・HANDOFF §0-3）:
//   ・県別（任意継続の料率・上限）＝ shaho 側で計算（この関数群）。
//   ・市区町村別（国保）＝ kokuho 側の正本（registry/index.json）に委譲。shaho は city キーを複製しない。
//   ・国保の保険料計算は shaho では行わない。kokuho の計算ページへ URL で送る（正本委譲＝台帳二重管理の防止）。

// 標準報酬月額が「等級値」であることを検証（Fable5軽微③：非等級値を素通ししない）。
// 有効値は standard-monthly.json explicitBoundaries の standardMonthly（協会けんぽ・船員 共通の50等級表）。
function assertGradeValue(formerStandardMonthly, data) {
  const B = data.standard && data.standard.explicitBoundaries;
  if (!Array.isArray(B) || B.length === 0) throw new Error('standard-monthly.json explicitBoundaries が必要');
  const valid = B.map((b) => b.standardMonthly);
  if (!valid.includes(formerStandardMonthly)) {
    throw new Error(`formerStandardMonthly=${formerStandardMonthly} は標準報酬月額の等級値でない（例: ${valid[0]}, ${valid[1]}, … ${valid[valid.length - 1]} のいずれか）`);
  }
}

// 年額換算の注記（Fable5軽微④：月額×12 は概算・料率未公表期間を跨ぐ場合の断り）。
const ANNUAL_NOTE = '年額は月額×12の概算。料率は年度で改定され得るため（健保3月分〜／支援金4月分〜）、年度を跨ぐ実額とは一致しないことがある';

// 任意継続被保険者の月額保険料（純粋関数）。
// 任意継続は「全額自己負担」（労使折半なし）・健康保険のみ（厚年/雇用なし）。
// input = { prefSlug, formerStandardMonthly, age, targetMonth, healthProvider? }
//   healthProvider="kyoukai"(既定): 協会けんぽ任意継続（50等級・上限320,000・県別率）
//   healthProvider="senpo":        船員 疾病任意継続（29等級・上限470,000・全国一律・一般10.33%）
function calcNiniKeizoku(input, data) {
  if (!input) throw new Error('calcNiniKeizoku: input がありません');
  const { prefSlug, formerStandardMonthly, age, targetMonth } = input;
  const provider = input.healthProvider || 'kyoukai';
  if (!targetMonth) throw new Error('targetMonth（対象月）は必須（フォールバック禁止）');
  if (typeof formerStandardMonthly !== 'number' || formerStandardMonthly <= 0) {
    throw new Error('formerStandardMonthly（資格喪失時の標準報酬月額）が不正');
  }
  assertGradeValue(formerStandardMonthly, data);
  const ageKnown = typeof age === 'number';
  const isCareAge = ageKnown && age >= 40 && age <= 64;

  if (provider === 'kyoukai') {
    const { kenpo } = data;
    const nk = kenpo.niniKeizoku;
    if (!nk) throw new Error('kenpo.niniKeizoku（任意継続の上限）が未定義');
    // 任意継続は4月分〜適用（健保本体の3月分と1ヶ月ずれ）。対象月が validFrom 前なら throw（暗黙適用しない）。
    if (nk.validFrom && monthIndex(targetMonth) < monthIndex(nk.validFrom)) {
      throw new Error(`任意継続は ${nk.validFrom} 分から適用。対象月 ${targetMonth} は適用前（フォールバック禁止）`);
    }
    // 健保料率・介護・支援金は協会けんぽ本体と同じ resolveHealth で解決（県別率・期間・介護年齢を共有）
    const h = resolveHealth({ healthProvider: 'kyoukai', prefSlug, age, targetMonth }, data);
    const cap = nk.capStandardMonthly;
    const std = Math.min(formerStandardMonthly, cap);
    const capped = formerStandardMonthly > cap;
    // 全額自己負担＝率をそのまま乗じる（折半しない）
    const health = std * h.healthRate;
    const care = h.careApplies ? std * h.careRate : 0;
    const shienkin = h.shienkinApplies ? std * h.shienkinRate : 0;
    const total = health + care + shienkin;
    return {
      kind: 'niniKeizoku', provider: 'kyoukai',
      input: { prefSlug, formerStandardMonthly, age: age ?? null, targetMonth },
      standardMonthly: std, cap, capped, capGrade: nk.capGrade ?? null,
      fullSelfBorne: true,
      monthly: {
        health, care, shienkin, total,
        careApplies: h.careApplies, careReason: h.careReason,
        note: '任意継続は全額自己負担（労使折半なし）・健康保険のみ（厚年/雇用は対象外）',
      },
      annual: total * 12, annualNote: ANNUAL_NOTE,
      meta: {
        provider: 'kyoukai', prefSlug, prefName: h.meta.prefName,
        healthRate: h.healthRate, careApplies: h.careApplies, careRate: h.careRate,
        shienkinApplies: h.shienkinApplies, shienkinRate: h.shienkinRate,
        capBasis: { avgYen: nk.basisAvgYen ?? null, basisDate: nk.basisDate ?? null },
        validFrom: nk.validFrom ?? null,
        source: nk.source ?? null, verifiedAt: nk.verifiedAt ?? null,
      },
    };
  }

  if (provider === 'senpo') {
    // 船員 疾病任意継続（senpo.ninkei）。全額自己負担（船主負担なし）・29等級・上限470,000・全国一律。
    // 一般保険料率10.33%（疾病10.00＋災害0.33）を自己負担。介護該当は+1.76%（合計12.09%）。支援金0.23%。
    const senpo = data.senpo;
    if (!senpo || !senpo.ninkei) throw new Error('senpo.ninkei データ未読込（senpo-2026.json）');
    const nk = senpo.ninkei;
    // 適用期間: ninkei.validFrom（4月分〜）以降、船員データの年度末まで。範囲外は throw（フォールバック禁止）。
    const boundTo = (senpo.zaishoku && senpo.zaishoku.validTo) || null;
    if (nk.validFrom && monthIndex(targetMonth) < monthIndex(nk.validFrom)) {
      throw new Error(`船員 疾病任意継続は ${nk.validFrom} 分から適用。対象月 ${targetMonth} は適用前（フォールバック禁止）`);
    }
    if (boundTo && monthIndex(targetMonth) > monthIndex(boundTo)) {
      throw new Error(`船員 疾病任意継続の料率が対象月 ${targetMonth} に未定義（${boundTo} まで・フォールバック禁止）`);
    }
    const careRow = senpo.care;
    const careInPeriod = inPeriod(targetMonth, careRow.validFrom, careRow.validTo);
    const careApplies = isCareAge && careInPeriod;
    const cap = nk.capStandardMonthly; // 470,000
    const std = Math.min(formerStandardMonthly, cap);
    const capped = formerStandardMonthly > cap;
    const healthRate = nk.generalRate;                // 0.1033（疾病10.00＋災害0.33・全額自己負担）
    const careRate = careApplies ? careRow.rate : 0;  // 0.0176
    const shienkinApplies = monthIndex(targetMonth) >= monthIndex(nk.validFrom);
    const shienkinRate = shienkinApplies ? nk.shienkinRate : 0; // 0.0023
    const health = std * healthRate;
    const care = std * careRate;
    const shienkin = std * shienkinRate;
    const total = health + care + shienkin;
    const careReason = careApplies ? null
      : (!ageKnown ? 'age-unknown（年齢未指定）' : (age < 40 ? 'under-40' : (age > 64 ? 'over-64' : 'out-of-period')));
    return {
      kind: 'niniKeizoku', provider: 'senpo',
      input: { formerStandardMonthly, age: age ?? null, targetMonth },
      standardMonthly: std, cap, capped, capGrade: nk.capGrade ?? null,
      fullSelfBorne: true,
      monthly: {
        health, care, shienkin, total,
        careApplies, careReason,
        note: '船員 疾病任意継続は全額自己負担（船主負担なし）。一般率10.33%（疾病10.00＋災害0.33）＋介護該当1.76%＋支援金0.23%。健康保険のみ',
      },
      annual: total * 12, annualNote: ANNUAL_NOTE,
      meta: {
        provider: 'senpo', prefSlug: null, prefName: null,
        healthRate, careApplies, careRate, shienkinApplies, shienkinRate,
        generalRate: nk.generalRate, careAppliedTotalRate: nk.careAppliedTotalRate ?? null,
        validFrom: nk.validFrom ?? null, validTo: boundTo,
        source: (senpo.source && (senpo.source.ninkeiLeaflet || senpo.source.ratePage)) || null,
        verifiedAt: (senpo.source && senpo.source.verifiedAt) || null,
      },
    };
  }

  throw new Error(`calcNiniKeizoku: healthProvider '${provider}' は未対応（"kyoukai"|"senpo"）`);
}

// 市区町村を kokuho registry（正本）で解決する片方向リンカ。
// shaho は citySlug/cityCode を発明・複製しない（正本＝kokuho-core/registry/index.json）。
// 国保の保険料計算はしない。存在確認＋県整合＋kokuho計算ページURLの発行のみ。
// registry = kokuho-core/registry/index.json（{ municipalities:[...] }）を呼び出し側が渡す。
function resolveHikakuCity(citySlug, registry, opts) {
  opts = opts || {};
  const baseUrl = opts.kokuhoBaseUrl || 'https://kokuho-keisan.jp';
  if (!citySlug) throw new Error('citySlug は必須');
  const muni = (registry && registry.municipalities) || null;
  if (!Array.isArray(muni)) throw new Error('registry.municipalities が無い（kokuho-core/registry/index.json を渡す）');
  const hit = muni.find((m) => m.citySlug === citySlug);
  if (!hit) {
    return { found: false, citySlug, reason: `citySlug '${citySlug}' は kokuho registry（正本）に存在しない` };
  }
  // 国保を扱う自治体か（systems に "kokuho"）を確認（片方向・正本の systems を尊重）
  const hasKokuho = Array.isArray(hit.systems) && hit.systems.includes('kokuho');
  return {
    found: true,
    citySlug: hit.citySlug, cityCode: hit.cityCode, cityName: hit.cityName,
    prefecture: hit.prefecture, prefectureSlug: hit.prefectureSlug,
    hasKokuho,
    kokuhoUrl: `${baseUrl}/${hit.prefectureSlug}/${hit.citySlug}/income.html`,
    note: '国保の計算・データは kokuho 側の正本に委譲（片方向）。shaho は存在確認とURL発行のみ',
  };
}

// /hikaku/ の結線本体：任意継続（shaho計算）＋ 国保（kokuho委譲リンク）を1つの比較コントラクトに束ねる。
// citySlug から県を registry で解決 → その県の任意継続を計算 → 国保は kokuho URL を添える（計算しない）。
// input = { citySlug, formerStandardMonthly, age, targetMonth }
function buildHikaku(input, data, registry, opts) {
  if (!input || !input.citySlug) throw new Error('buildHikaku: input.citySlug は必須');
  const city = resolveHikakuCity(input.citySlug, registry, opts);
  if (!city.found) {
    return { ok: false, city, reason: city.reason };
  }
  // 県は kokuho registry の prefectureSlug を正本として採用（shaho 側で県を複製しない＝片方向）
  const prefSlug = city.prefectureSlug;
  const nini = calcNiniKeizoku({
    prefSlug,
    formerStandardMonthly: input.formerStandardMonthly,
    age: input.age,
    targetMonth: input.targetMonth,
  }, data);
  return {
    ok: true,
    targetMonth: input.targetMonth,
    city,                       // 市区町村（kokuho 正本由来・片方向）
    niniKeizoku: nini,          // 任意継続（shaho 計算）
    kokuho: {                   // 国保側は委譲（shaho は計算しない）
      delegated: true,
      url: city.kokuhoUrl,
      hasKokuho: city.hasKokuho,
      note: '国保保険料は kokuho 側で計算。ここでは比較のための導線URLのみを提供（正本委譲・片方向）',
    },
    disclaimer: '任意継続=協会けんぽ全額自己負担（健保のみ）。国保=自治体ごとに算定方式が異なるため kokuho の計算結果と突き合わせて比較すること。',
  };
}

// ---- データ読込（node実行・生成スクリプト用。ブラウザではfetch結果を渡す） ---------
function loadData(dir) {
  if (!fs || !path) throw new Error('loadData は Node 専用。ブラウザでは fetch した JSON を calculateShaho(input, data) に直接渡す');
  const base = dir || path.resolve(__dirname, '../../');
  const read = (f) => JSON.parse(fs.readFileSync(path.resolve(base, f), 'utf8'));
  const readOpt = (f) => {
    // 任意ファイル（senpo/kumiai 等の provider 追加分）。ファイル不在(ENOENT)のみ null＝既定 kyoukai は無影響。
    // JSON構文エラー等は握りつぶさず throw（データ破損を「provider消失」として静かに扱わない＝SEC-STOP）。
    try {
      return read(f);
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw new Error(`${f} の読込に失敗（ファイルは存在するが破損の疑い）: ${e.message}`);
    }
  };
  return {
    kenpo: read('kenpo-2026.json'),
    kosei: read('kosei-nenkin.json'),
    koyo: read('koyo-2026.json'),
    standard: read('standard-monthly.json'),
    senpo: readOpt('senpo-2026.json'), // §7-8 船員保険（healthProvider:"senpo"）
  };
}

const _api = {
  calculateShaho, calcBonus, loadData,
  calcNiniKeizoku, resolveHikakuCity, buildHikaku, // /hikaku/ 結線（任意継続 vs 国保・片方向）
  kenpoGrade, koseiStandard, roundEmployeeDeduct, monthIndex, inPeriod,
};
if (_isNode) module.exports = _api;                              // Node: require で使う
if (typeof window !== 'undefined') window.Shaho = _api;          // ブラウザ: window.Shaho で使う

// ---- 自己テスト（node js/core/shaho.js）。ブラウザでは require 未定義でスキップ ----
if (_isNode && require.main === module) {
  const data = loadData();
  let pass = 0, fail = 0;
  const eq = (label, got, exp) => {
    const ok = Math.abs(got - exp) < 1e-6;
    console.log(`${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : ` (期待 ${exp})`}`);
    ok ? pass++ : fail++;
  };
  const thr = (label, fn) => {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    console.log(`${threw ? '✓' : '✗'} ${label}: ${threw ? 'throw' : 'throwしない'}`);
    threw ? pass++ : fail++;
  };

  console.log('— 標準報酬・等級 —');
  eq('報酬300,000→健保std', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).standardMonthly.kenpo, 300000);
  eq('報酬60,000→厚年std=下限88,000', calculateShaho({ monthlySalary: 60000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).standardMonthly.koseiNenkin, 88000);
  eq('報酬700,000→厚年std=上限650,000', calculateShaho({ monthlySalary: 700000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).standardMonthly.koseiNenkin, 650000);
  eq('報酬1,355,000→50等級std', calculateShaho({ monthlySalary: 1355000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).standardMonthly.kenpo, 1390000);

  console.log('— 東京 折半額（公式表と一致）—');
  const t = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 45 }, data);
  eq('健保のみ折半', t.health.half, 14775);
  eq('健保+介護折半', t.healthWithCare.half, 17205);
  eq('支援金折半', t.shienkin.half, 345);
  eq('厚年折半', t.koseiNenkin.half, 27450);

  console.log('— 対象月による支援金の有無 —');
  eq('2026-03分は支援金0', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-03', prefSlug: 'tokyo', age: 30 }, data).shienkin.half, 0);
  eq('2026-04分から支援金', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-04', prefSlug: 'tokyo', age: 30 }, data).shienkin.half, 345);

  console.log('— 介護は40-64歳のみ —');
  eq('30歳は介護0', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).care.half, 0);
  eq('45歳は介護あり(折半2430)', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 45 }, data).care.half, 2430); // 300000*0.0162/2

  console.log('— 端数処理（50銭ルール①）—');
  eq('2856.5→切捨2856', roundEmployeeDeduct(2856.5), 2856);
  eq('66.7→切上67', roundEmployeeDeduct(66.7), 67);
  eq('3349.0→3349', roundEmployeeDeduct(3349.0), 3349);

  console.log('— フォールバック禁止（throw）—');
  thr('対象月なし→throw', () => calculateShaho({ monthlySalary: 300000, prefSlug: 'tokyo', age: 30 }, data));
  thr('R7(2025-12)→throw', () => calculateShaho({ monthlySalary: 300000, targetMonth: '2025-12', prefSlug: 'tokyo', age: 30 }, data));
  thr('未知pref→throw', () => calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'atlantis', age: 30 }, data));

  console.log('— 雇用保険（賃金総額ベース）—');
  eq('一般 労働者負担 300,000×5/1000', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30, koyoCategory: 'ippan' }, data).koyo.employee, 1500);

  console.log('— 賞与 —');
  const b = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30, bonus: 500500 }, data).bonus;
  eq('標準賞与額=1000円未満切捨', b.standardBonus, 500000);
  eq('賞与 雇用保険=賞与額×0.005（標準賞与でなく賃金総額）', b.koyo.employee, 2502.5); // 500500*0.005
  eq('賞与573万内: 健保base=標準賞与額・cap未適用', b.health.base, 500000);
  eq('賞与573万内: healthYearCap.applied=false', b.healthYearCap.applied ? 1 : 0, 0);

  console.log('— 賞与 健保系 年度573万上限（[確認済]）—');
  const bCap = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30, bonus: 6000000 }, data).bonus;
  eq('単発600万: 健保base=573万にcap', bCap.health.base, 5730000);
  eq('単発600万: 支援金base=573万にcap', bCap.shienkin.base, 5730000);
  eq('単発600万: healthYearCap.applied=true', bCap.healthYearCap.applied ? 1 : 0, 1);
  eq('単発600万: 厚年base=150万（別上限・不変）', bCap.koseiNenkin.base, 1500000);
  eq('単発600万: 健保折半=573万×0.0985/2', bCap.health.half, 5730000 * 0.0985 / 2);
  const bYtd = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30, bonus: 5000000, bonusYearToDate: 3000000 }, data).bonus;
  eq('累計300万既支給: 残枠273万でcap', bYtd.health.base, 2730000); // 5,730,000-3,000,000
  eq('累計300万既支給: remainingCap=273万', bYtd.healthYearCap.remainingCap, 2730000);
  const bSenpoCap = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'senpo', age: 30, bonus: 6000000 }, data).bonus;
  eq('船員 単発600万: 健保base=573万にcap', bSenpoCap.health.base, 5730000);
  eq('船員 単発600万: 疾病本人=573万×0.0495', bSenpoCap.health.employee, 5730000 * 0.0495);

  console.log('— healthProvider 拡張シーム（§7-6）—');
  eq('既定=kyoukai', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).input.healthProvider === 'kyoukai' ? 1 : 0, 1);
  eq('kyoukai: health.employee===health.half（無回帰）',
    (() => { const r = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 45 }, data); return Math.abs(r.health.employee - r.health.half) < 1e-9 ? 1 : 0; })(), 1);
  eq('kyoukai: splitModel=half', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).splitModel === 'half' ? 1 : 0, 1);
  eq('中立エイリアス grade.health', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).grade.health, calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).grade.kenpo);
  eq('中立エイリアス standardMonthly.health', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data).standardMonthly.health, 300000);
  thr('kumiai未実装→throw', () => calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'kumiai', prefSlug: 'tokyo', age: 30 }, data));
  thr('未知provider→throw', () => calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'xxx', prefSlug: 'tokyo', age: 30 }, data));

  console.log('— 船員保険 senpo（§7-8・在職船員）—');
  const sp = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'senpo', age: 45 }, data);
  eq('senpo: prefSlug不要で計算可（splitModel=explicit）', sp.splitModel === 'explicit' ? 1 : 0, 1);
  eq('senpo: 疾病 全額=std×0.10', sp.health.full, 30000);
  eq('senpo: 疾病 本人=std×0.0495（総率÷2でない）', sp.health.employee, 14850);
  eq('senpo: 疾病 本人≠折半（14850≠15000）', Math.abs(sp.health.employee - sp.health.half) > 1 ? 1 : 0, 1);
  eq('senpo: 介護 本人=std×0.0088（45歳）', sp.care.employee, 2640);
  eq('senpo: 支援金 本人=std×0.00115', sp.shienkin.employee, 345);
  eq('senpo: 厚年 本人=折半27450', sp.koseiNenkin.employee, 27450);
  eq('senpo: 災害は本人負担ゼロ・全額船主(std×0.0105=3150)', sp.employerOnly[0].full, 3150);
  eq('senpo: 災害 本人=0', sp.employerOnly[0].employee, 0);
  eq('senpo: 雇用は一般率流用（300000×0.005=1500）', sp.koyo.employee, 1500);
  eq('senpo: 30歳は介護0', calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'senpo', age: 30 }, data).care.employee, 0);
  eq('senpo: 賞与 疾病本人=std賞与×0.0495',
    calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'senpo', age: 30, bonus: 500000 }, data).bonus.health.employee, 24750); // 500000*0.0495
  thr('senpo: senpoデータ無し→throw', () => calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', healthProvider: 'senpo', age: 30 }, { kenpo: data.kenpo, kosei: data.kosei, koyo: data.koyo, standard: data.standard }));
  thr('senpo: R7(2025-12)→throw（期間外）', () => calculateShaho({ monthlySalary: 300000, targetMonth: '2025-12', healthProvider: 'senpo', age: 30 }, data));

  console.log('— /hikaku/ 任意継続（全額自己負担・上限320,000）—');
  // 上限以下: 標準報酬30万・東京・2026-07・45歳（介護あり）。全額自己負担＝率そのまま。
  const nk1 = calcNiniKeizoku({ prefSlug: 'tokyo', formerStandardMonthly: 300000, age: 45, targetMonth: '2026-07' }, data);
  eq('任継: std=300,000（上限内）', nk1.standardMonthly, 300000);
  eq('任継: 健保 全額=300000×0.0985', nk1.monthly.health, 29550);   // 折半でなく全額
  eq('任継: 介護 全額=300000×0.0162（45歳）', nk1.monthly.care, 4860);
  eq('任継: 支援金 全額=300000×0.0023', nk1.monthly.shienkin, 690);
  eq('任継: 合計=健保+介護+支援金', nk1.monthly.total, 29550 + 4860 + 690);
  // 上限超え: 資格喪失時41万(有効等級) → std は 320,000 にクランプ
  const nk2 = calcNiniKeizoku({ prefSlug: 'tokyo', formerStandardMonthly: 410000, age: 30, targetMonth: '2026-07' }, data);
  eq('任継: 上限320,000にクランプ', nk2.standardMonthly, 320000);
  eq('任継: capped=true', nk2.capped ? 1 : 0, 1);
  eq('任継: 30歳は介護0', nk2.monthly.care, 0);
  eq('任継: 30歳の介護reason=under-40', /under-40/.test(nk2.monthly.careReason || '') ? 1 : 0, 1);
  eq('任継: annualNote あり', nk2.annualNote ? 1 : 0, 1);
  thr('任継: 2026-03分は適用前→throw（4月分〜）', () => calcNiniKeizoku({ prefSlug: 'tokyo', formerStandardMonthly: 300000, age: 30, targetMonth: '2026-03' }, data));
  thr('任継: 非等級値305,000→throw（Fable5③）', () => calcNiniKeizoku({ prefSlug: 'tokyo', formerStandardMonthly: 305000, age: 30, targetMonth: '2026-07' }, data));

  console.log('— 船員 疾病任意継続（senpo.ninkei・29等級・上限47万・全額自己負担）—');
  const sn = calcNiniKeizoku({ healthProvider: 'senpo', formerStandardMonthly: 300000, age: 45, targetMonth: '2026-07' }, data);
  eq('船員任継: 一般10.33%を全額自己負担=300000×0.1033', sn.monthly.health, 30990);
  eq('船員任継: 介護=300000×0.0176（45歳）', sn.monthly.care, 5280);
  eq('船員任継: 支援金=300000×0.0023', sn.monthly.shienkin, 690);
  eq('船員任継: 上限470,000にクランプ', calcNiniKeizoku({ healthProvider: 'senpo', formerStandardMonthly: 500000, age: 30, targetMonth: '2026-07' }, data).standardMonthly, 470000);
  eq('船員任継: provider=senpo', sn.provider === 'senpo' ? 1 : 0, 1);
  thr('船員任継: 2026-03は適用前→throw', () => calcNiniKeizoku({ healthProvider: 'senpo', formerStandardMonthly: 300000, age: 30, targetMonth: '2026-03' }, data));

  console.log('— 介護reason（Fable5①）/ koseiFloored（②）—');
  const cr = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo' }, data); // age未指定
  eq('age未指定→care.reason=age-unknown', /age-unknown/.test(cr.care.reason || '') ? 1 : 0, 1);
  const c65 = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 66 }, data);
  eq('66歳→care.reason=over-64', /over-64/.test(c65.care.reason || '') ? 1 : 0, 1);
  const cFloor = calculateShaho({ monthlySalary: 60000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data);
  eq('報酬60,000→厚年 koseiFloored=true・koseiCapped=false', (cFloor.grade.koseiFloored && !cFloor.grade.koseiCapped) ? 1 : 0, 1);
  const cCap = calculateShaho({ monthlySalary: 700000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 30 }, data);
  eq('報酬700,000→厚年 koseiCapped=true・koseiFloored=false', (cCap.grade.koseiCapped && !cCap.grade.koseiFloored) ? 1 : 0, 1);

  console.log('— /hikaku/ 市区町村の kokuho 正本委譲（片方向・モックregistry）—');
  const mockReg = { municipalities: [
    { cityCode: '13112', citySlug: 'setagaya', cityName: '世田谷区', prefecture: '東京都', prefectureSlug: 'tokyo', systems: ['kokuho','kaigo'] },
    { cityCode: '14100', citySlug: 'yokohama', cityName: '横浜市', prefecture: '神奈川県', prefectureSlug: 'kanagawa', systems: ['kokuho'] },
  ] };
  const rc = resolveHikakuCity('yokohama', mockReg);
  eq('linker: 正本に存在→found', rc.found ? 1 : 0, 1);
  eq('linker: prefectureSlug は registry 由来', rc.prefectureSlug === 'kanagawa' ? 1 : 0, 1);
  eq('linker: kokuho計算ページURL発行', rc.kokuhoUrl === 'https://kokuho-keisan.jp/kanagawa/yokohama/income.html' ? 1 : 0, 1);
  eq('linker: 未知slugは found:false（発明しない）', resolveHikakuCity('atlantis', mockReg).found ? 1 : 0, 0);
  // buildHikaku: citySlug→県解決→任継計算＋国保はURL委譲
  const hk = buildHikaku({ citySlug: 'setagaya', formerStandardMonthly: 300000, age: 45, targetMonth: '2026-07' }, data, mockReg);
  eq('buildHikaku: ok', hk.ok ? 1 : 0, 1);
  eq('buildHikaku: 県は registry の tokyo で任継計算', hk.niniKeizoku.meta.prefSlug === 'tokyo' ? 1 : 0, 1);
  eq('buildHikaku: 国保は委譲（計算せずURLのみ）', hk.kokuho.delegated && hk.kokuho.url ? 1 : 0, 1);

  console.log('— meta（適用期間・出典）—');
  const mt = calculateShaho({ monthlySalary: 300000, targetMonth: '2026-07', prefSlug: 'tokyo', age: 45 }, data).meta;
  eq('meta.health.validFrom=2026-03', mt.health.validFrom === '2026-03' ? 1 : 0, 1);
  eq('meta.health.source あり', mt.health.source ? 1 : 0, 1);
  eq('meta.koyo.validFrom=2026-04', mt.koyo.validFrom === '2026-04' ? 1 : 0, 1);
  eq('meta.koseiNenkin.source あり', mt.koseiNenkin.source ? 1 : 0, 1);

  console.log(`\n結果: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}
