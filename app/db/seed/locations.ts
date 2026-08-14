/**
 * 地域マスタの初期データ。
 *
 * code は総務省の全国地方公共団体コード（検査数字を除いた上5桁のうち、
 * 都道府県は2桁・市区町村は5桁）。
 *
 * ★市区町村は主要な自治体のみを収録している。★ 全1,700余を入れていない
 * のは、MVP の投入と保守の手間に見合わないため。追加は
 * OPERATIONS.md「地域マスタの更新」の手順で行う（行を消さず is_active を
 * 落とす。過去の投稿が参照しているため）。
 */

export interface PrefectureSeed {
  readonly code: string;
  readonly name: string;
  readonly kana: string;
  readonly romaji: string;
}

export const PREFECTURES: readonly PrefectureSeed[] = [
  { code: "01", name: "北海道", kana: "ほっかいどう", romaji: "hokkaido" },
  { code: "02", name: "青森県", kana: "あおもりけん", romaji: "aomori" },
  { code: "03", name: "岩手県", kana: "いわてけん", romaji: "iwate" },
  { code: "04", name: "宮城県", kana: "みやぎけん", romaji: "miyagi" },
  { code: "05", name: "秋田県", kana: "あきたけん", romaji: "akita" },
  { code: "06", name: "山形県", kana: "やまがたけん", romaji: "yamagata" },
  { code: "07", name: "福島県", kana: "ふくしまけん", romaji: "fukushima" },
  { code: "08", name: "茨城県", kana: "いばらきけん", romaji: "ibaraki" },
  { code: "09", name: "栃木県", kana: "とちぎけん", romaji: "tochigi" },
  { code: "10", name: "群馬県", kana: "ぐんまけん", romaji: "gunma" },
  { code: "11", name: "埼玉県", kana: "さいたまけん", romaji: "saitama" },
  { code: "12", name: "千葉県", kana: "ちばけん", romaji: "chiba" },
  { code: "13", name: "東京都", kana: "とうきょうと", romaji: "tokyo" },
  { code: "14", name: "神奈川県", kana: "かながわけん", romaji: "kanagawa" },
  { code: "15", name: "新潟県", kana: "にいがたけん", romaji: "niigata" },
  { code: "16", name: "富山県", kana: "とやまけん", romaji: "toyama" },
  { code: "17", name: "石川県", kana: "いしかわけん", romaji: "ishikawa" },
  { code: "18", name: "福井県", kana: "ふくいけん", romaji: "fukui" },
  { code: "19", name: "山梨県", kana: "やまなしけん", romaji: "yamanashi" },
  { code: "20", name: "長野県", kana: "ながのけん", romaji: "nagano" },
  { code: "21", name: "岐阜県", kana: "ぎふけん", romaji: "gifu" },
  { code: "22", name: "静岡県", kana: "しずおかけん", romaji: "shizuoka" },
  { code: "23", name: "愛知県", kana: "あいちけん", romaji: "aichi" },
  { code: "24", name: "三重県", kana: "みえけん", romaji: "mie" },
  { code: "25", name: "滋賀県", kana: "しがけん", romaji: "shiga" },
  { code: "26", name: "京都府", kana: "きょうとふ", romaji: "kyoto" },
  { code: "27", name: "大阪府", kana: "おおさかふ", romaji: "osaka" },
  { code: "28", name: "兵庫県", kana: "ひょうごけん", romaji: "hyogo" },
  { code: "29", name: "奈良県", kana: "ならけん", romaji: "nara" },
  { code: "30", name: "和歌山県", kana: "わかやまけん", romaji: "wakayama" },
  { code: "31", name: "鳥取県", kana: "とっとりけん", romaji: "tottori" },
  { code: "32", name: "島根県", kana: "しまねけん", romaji: "shimane" },
  { code: "33", name: "岡山県", kana: "おかやまけん", romaji: "okayama" },
  { code: "34", name: "広島県", kana: "ひろしまけん", romaji: "hiroshima" },
  { code: "35", name: "山口県", kana: "やまぐちけん", romaji: "yamaguchi" },
  { code: "36", name: "徳島県", kana: "とくしまけん", romaji: "tokushima" },
  { code: "37", name: "香川県", kana: "かがわけん", romaji: "kagawa" },
  { code: "38", name: "愛媛県", kana: "えひめけん", romaji: "ehime" },
  { code: "39", name: "高知県", kana: "こうちけん", romaji: "kochi" },
  { code: "40", name: "福岡県", kana: "ふくおかけん", romaji: "fukuoka" },
  { code: "41", name: "佐賀県", kana: "さがけん", romaji: "saga" },
  { code: "42", name: "長崎県", kana: "ながさきけん", romaji: "nagasaki" },
  { code: "43", name: "熊本県", kana: "くまもとけん", romaji: "kumamoto" },
  { code: "44", name: "大分県", kana: "おおいたけん", romaji: "oita" },
  { code: "45", name: "宮崎県", kana: "みやざきけん", romaji: "miyazaki" },
  { code: "46", name: "鹿児島県", kana: "かごしまけん", romaji: "kagoshima" },
  { code: "47", name: "沖縄県", kana: "おきなわけん", romaji: "okinawa" },
];

export interface CitySeed {
  readonly code: string;
  readonly parentCode: string;
  readonly name: string;
}

/**
 * 市区町村。県庁所在地・政令指定都市・東京23区を中心に収録。
 * 「その他（〇〇県内）」は、収録外の自治体から投稿したい人の受け皿。
 */
export const CITIES: readonly CitySeed[] = [
  // 北海道
  { code: "01100", parentCode: "01", name: "札幌市" },
  { code: "01202", parentCode: "01", name: "函館市" },
  { code: "01204", parentCode: "01", name: "旭川市" },
  { code: "01207", parentCode: "01", name: "釧路市" },
  { code: "01206", parentCode: "01", name: "帯広市" },
  // 東北
  { code: "02201", parentCode: "02", name: "青森市" },
  { code: "02203", parentCode: "02", name: "八戸市" },
  { code: "03201", parentCode: "03", name: "盛岡市" },
  { code: "04100", parentCode: "04", name: "仙台市" },
  { code: "04205", parentCode: "04", name: "石巻市" },
  { code: "05201", parentCode: "05", name: "秋田市" },
  { code: "06201", parentCode: "06", name: "山形市" },
  { code: "07201", parentCode: "07", name: "福島市" },
  { code: "07203", parentCode: "07", name: "郡山市" },
  { code: "07204", parentCode: "07", name: "いわき市" },
  // 関東（東京以外）
  { code: "08201", parentCode: "08", name: "水戸市" },
  { code: "08220", parentCode: "08", name: "つくば市" },
  { code: "09201", parentCode: "09", name: "宇都宮市" },
  { code: "10201", parentCode: "10", name: "前橋市" },
  { code: "10202", parentCode: "10", name: "高崎市" },
  { code: "11100", parentCode: "11", name: "さいたま市" },
  { code: "11203", parentCode: "11", name: "川口市" },
  { code: "11201", parentCode: "11", name: "川越市" },
  { code: "11202", parentCode: "11", name: "熊谷市" },
  { code: "11215", parentCode: "11", name: "所沢市" },
  { code: "12100", parentCode: "12", name: "千葉市" },
  { code: "12203", parentCode: "12", name: "市川市" },
  { code: "12204", parentCode: "12", name: "船橋市" },
  { code: "12207", parentCode: "12", name: "松戸市" },
  { code: "12217", parentCode: "12", name: "柏市" },
  { code: "14100", parentCode: "14", name: "横浜市" },
  { code: "14130", parentCode: "14", name: "川崎市" },
  { code: "14150", parentCode: "14", name: "相模原市" },
  { code: "14201", parentCode: "14", name: "横須賀市" },
  { code: "14203", parentCode: "14", name: "平塚市" },
  { code: "14204", parentCode: "14", name: "鎌倉市" },
  { code: "14205", parentCode: "14", name: "藤沢市" },
  { code: "14207", parentCode: "14", name: "茅ヶ崎市" },
  { code: "14213", parentCode: "14", name: "厚木市" },
  // 東京23区
  { code: "13101", parentCode: "13", name: "千代田区" },
  { code: "13102", parentCode: "13", name: "中央区" },
  { code: "13103", parentCode: "13", name: "港区" },
  { code: "13104", parentCode: "13", name: "新宿区" },
  { code: "13105", parentCode: "13", name: "文京区" },
  { code: "13106", parentCode: "13", name: "台東区" },
  { code: "13107", parentCode: "13", name: "墨田区" },
  { code: "13108", parentCode: "13", name: "江東区" },
  { code: "13109", parentCode: "13", name: "品川区" },
  { code: "13110", parentCode: "13", name: "目黒区" },
  { code: "13111", parentCode: "13", name: "大田区" },
  { code: "13112", parentCode: "13", name: "世田谷区" },
  { code: "13113", parentCode: "13", name: "渋谷区" },
  { code: "13114", parentCode: "13", name: "中野区" },
  { code: "13115", parentCode: "13", name: "杉並区" },
  { code: "13116", parentCode: "13", name: "豊島区" },
  { code: "13117", parentCode: "13", name: "北区" },
  { code: "13118", parentCode: "13", name: "荒川区" },
  { code: "13119", parentCode: "13", name: "板橋区" },
  { code: "13120", parentCode: "13", name: "練馬区" },
  { code: "13121", parentCode: "13", name: "足立区" },
  { code: "13122", parentCode: "13", name: "葛飾区" },
  { code: "13123", parentCode: "13", name: "江戸川区" },
  // 東京多摩
  { code: "13201", parentCode: "13", name: "八王子市" },
  { code: "13202", parentCode: "13", name: "立川市" },
  { code: "13203", parentCode: "13", name: "武蔵野市" },
  { code: "13204", parentCode: "13", name: "三鷹市" },
  { code: "13206", parentCode: "13", name: "府中市" },
  { code: "13208", parentCode: "13", name: "調布市" },
  { code: "13212", parentCode: "13", name: "町田市" },
  // 中部
  { code: "15100", parentCode: "15", name: "新潟市" },
  { code: "16201", parentCode: "16", name: "富山市" },
  { code: "17201", parentCode: "17", name: "金沢市" },
  { code: "18201", parentCode: "18", name: "福井市" },
  { code: "19201", parentCode: "19", name: "甲府市" },
  { code: "20201", parentCode: "20", name: "長野市" },
  { code: "20202", parentCode: "20", name: "松本市" },
  { code: "21201", parentCode: "21", name: "岐阜市" },
  { code: "22100", parentCode: "22", name: "静岡市" },
  { code: "22130", parentCode: "22", name: "浜松市" },
  { code: "22203", parentCode: "22", name: "沼津市" },
  { code: "23100", parentCode: "23", name: "名古屋市" },
  { code: "23201", parentCode: "23", name: "豊橋市" },
  { code: "23202", parentCode: "23", name: "岡崎市" },
  { code: "23207", parentCode: "23", name: "豊田市" },
  { code: "23206", parentCode: "23", name: "一宮市" },
  // 近畿
  { code: "24201", parentCode: "24", name: "津市" },
  { code: "24202", parentCode: "24", name: "四日市市" },
  { code: "25201", parentCode: "25", name: "大津市" },
  { code: "26100", parentCode: "26", name: "京都市" },
  { code: "27100", parentCode: "27", name: "大阪市" },
  { code: "27140", parentCode: "27", name: "堺市" },
  { code: "27203", parentCode: "27", name: "豊中市" },
  { code: "27205", parentCode: "27", name: "吹田市" },
  { code: "27207", parentCode: "27", name: "高槻市" },
  { code: "27210", parentCode: "27", name: "枚方市" },
  { code: "27202", parentCode: "27", name: "岸和田市" },
  { code: "28100", parentCode: "28", name: "神戸市" },
  { code: "28201", parentCode: "28", name: "姫路市" },
  { code: "28202", parentCode: "28", name: "尼崎市" },
  { code: "28204", parentCode: "28", name: "西宮市" },
  { code: "29201", parentCode: "29", name: "奈良市" },
  { code: "30201", parentCode: "30", name: "和歌山市" },
  // 中国・四国
  { code: "31201", parentCode: "31", name: "鳥取市" },
  { code: "32201", parentCode: "32", name: "松江市" },
  { code: "33100", parentCode: "33", name: "岡山市" },
  { code: "33202", parentCode: "33", name: "倉敷市" },
  { code: "34100", parentCode: "34", name: "広島市" },
  { code: "34202", parentCode: "34", name: "福山市" },
  { code: "35203", parentCode: "35", name: "山口市" },
  { code: "35201", parentCode: "35", name: "下関市" },
  { code: "36201", parentCode: "36", name: "徳島市" },
  { code: "37201", parentCode: "37", name: "高松市" },
  { code: "38201", parentCode: "38", name: "松山市" },
  { code: "39201", parentCode: "39", name: "高知市" },
  // 九州・沖縄
  { code: "40130", parentCode: "40", name: "福岡市" },
  { code: "40100", parentCode: "40", name: "北九州市" },
  { code: "40203", parentCode: "40", name: "久留米市" },
  { code: "41201", parentCode: "41", name: "佐賀市" },
  { code: "42201", parentCode: "42", name: "長崎市" },
  { code: "42202", parentCode: "42", name: "佐世保市" },
  { code: "43100", parentCode: "43", name: "熊本市" },
  { code: "44201", parentCode: "44", name: "大分市" },
  { code: "45201", parentCode: "45", name: "宮崎市" },
  { code: "46201", parentCode: "46", name: "鹿児島市" },
  { code: "47201", parentCode: "47", name: "那覇市" },
  { code: "47205", parentCode: "47", name: "沖縄市" },
];

/**
 * 収録外の自治体から投稿したい人の受け皿。
 * 都道府県ごとに1つ用意する（コードは 9xx を都道府県コードに続ける）。
 */
export function otherCityFor(prefectureCode: string): CitySeed {
  return {
    code: `${prefectureCode}999`,
    parentCode: prefectureCode,
    name: "その他の市区町村",
  };
}
