/**
 * Google Calendar → Notion 毎朝自動同期スクリプト
 *
 * 機能:
 * - 3つのGoogle Calendars（自分 / Nano / 瑛太）から60日間のイベントを取得
 * - Notion「子供向けイベント一覧 2026」に同期
 * - 重複検出ロジックで既存イベントをスキップ
 *
 * スケジュール: 毎朝7:00 AM JST（UTC 22:00）
 * トリガーID: trig_0181D1hc7f2X9rG5uKmydKc3
 */

const CALENDAR_CONFIG = {
  自分: "coco.lilie510@gmail.com",
  Nano: "72a4368b42366f8a31ee64491e336cf5f410f8223897200a7e551f7f4202ea58@group.calendar.google.com",
  瑛太: "adc2f84acb329693f79ae85ba45ba320beb087f9a0047ab1b8545b33515c44af@group.calendar.google.com"
};

const NOTION_CONFIG = {
  databaseName: "子供向けイベント一覧 2026",
  dataSourceId: "2d726114-ff27-4e15-8ded-068b480390d7",
  columns: {
    title: "イベント名",
    startDate: "期間（開始）",
    googleEventId: "GoogleイベントID",
    syncSourceCalendar: "同期元カレンダー",
    owner: "誰の予定"  // 自分/Nano/瑛太
  }
};

const SYNC_CONFIG = {
  rollingDays: 60,  // 今日から60日後までを取得
  duplicateDetectionLayers: [
    {
      layer: 1,
      name: "GoogleイベントID照合",
      logic: "GoogleイベントID が存在する行 → スキップ（同期済み）"
    },
    {
      layer: 2,
      name: "タプル照合",
      logic: "GoogleイベントID が空 → 「イベント名 + 開始日付 + 誰の予定」で既存判定"
    },
    {
      layer: 3,
      name: "新規判定",
      logic: "両方にマッチしない → Notionに追加"
    }
  ]
};

/**
 * メイン同期処理
 */
async function syncGoogleCalendarToNotion() {
  try {
    console.log("=== Google Calendar → Notion 同期開始 ===");
    console.log(`時刻: ${new Date().toLocaleString('ja-JP')}`);
    console.log(`同期対象: ${Object.keys(CALENDAR_CONFIG).join(", ")}`);

    // ステップ 1: Google Calendars から60日分のイベントを取得
    console.log("\n[ステップ 1] Google Calendar からイベント取得中...");
    const allEvents = await fetchEventsFromGoogleCalendars();
    console.log(`✓ 合計 ${allEvents.length} イベント取得`);

    // ステップ 2: Notion データベースの既存レコードを取得
    console.log("\n[ステップ 2] Notion 既存レコード取得中...");
    const existingRecords = await fetchExistingRecordsFromNotion();
    console.log(`✓ 既存 ${existingRecords.length} レコード取得`);

    // ステップ 3: 重複検出ロジックで新規イベントを識別
    console.log("\n[ステップ 3] 重複検出＆新規イベント識別中...");
    const newEvents = identifyNewEvents(allEvents, existingRecords);
    console.log(`✓ 新規イベント ${newEvents.length} 件検出`);

    // ステップ 4: 新規イベントを Notion に追加
    if (newEvents.length > 0) {
      console.log("\n[ステップ 4] 新規イベント Notion に追加中...");
      await createPagesInNotion(newEvents);
      console.log(`✓ ${newEvents.length} 件の新規イベントを追加完了`);
    } else {
      console.log("\n[ステップ 4] 新規イベントなし（スキップ）");
    }

    console.log("\n=== 同期完了 ===\n");
    return { success: true, newEventsCount: newEvents.length };

  } catch (error) {
    console.error("❌ エラー発生:", error.message);
    console.error("スタックトレース:", error.stack);
    // エラーログは出力するが処理は続行
    return { success: false, error: error.message };
  }
}

/**
 * Google Calendars から60日分のイベントを取得
 */
async function fetchEventsFromGoogleCalendars() {
  const events = [];
  const now = new Date();
  const endDate = new Date(now.getTime() + SYNC_CONFIG.rollingDays * 24 * 60 * 60 * 1000);

  for (const [owner, calendarId] of Object.entries(CALENDAR_CONFIG)) {
    try {
      console.log(`  取得中: ${owner} (${calendarId})`);

      const calendarEvents = await claude.mcp.google_calendar.list_events({
        calendarId: calendarId,
        timeMin: now.toISOString(),
        timeMax: endDate.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: "startTime"
      });

      // イベントにオーナー情報を付加
      calendarEvents.forEach(event => {
        events.push({
          ...event,
          owner: owner,
          sourceCalendar: calendarId
        });
      });

      console.log(`    ✓ ${calendarEvents.length} イベント取得`);
    } catch (error) {
      console.error(`  ❌ ${owner} から取得失敗:`, error.message);
      // エラーは記録するが他のカレンダーの処理は続行
    }
  }

  return events;
}

/**
 * Notion データベースから既存レコードを取得
 */
async function fetchExistingRecordsFromNotion() {
  try {
    const records = await claude.mcp.notion.notion_query_data_sources({
      id: NOTION_CONFIG.dataSourceId,
      sqlQuery: `SELECT * FROM data_source`
    });

    return records.map(record => ({
      id: record.id,
      title: record[NOTION_CONFIG.columns.title],
      startDate: record[NOTION_CONFIG.columns.startDate],
      googleEventId: record[NOTION_CONFIG.columns.googleEventId],
      owner: record[NOTION_CONFIG.columns.owner]
    }));
  } catch (error) {
    console.error("Notion クエリエラー:", error.message);
    throw error;
  }
}

/**
 * 重複検出ロジック - 新規イベントを識別
 *
 * Layer 1: GoogleイベントID で既に同期済みかチェック
 * Layer 2: GoogleイベントID がない場合、「イベント名 + 開始日付 + 誰の予定」で判定
 * Layer 3: 両方にマッチしなければ新規
 */
function identifyNewEvents(allEvents, existingRecords) {
  const newEvents = [];

  for (const event of allEvents) {
    const googleEventId = event.id;
    const eventTitle = event.summary;
    const startDate = extractDateString(event.start);
    const owner = event.owner;

    // Layer 1: GoogleイベントID で確認
    const existingByGoogleId = existingRecords.find(
      record => record.googleEventId === googleEventId && record.googleEventId
    );

    if (existingByGoogleId) {
      console.log(`  ⊙ スキップ（既同期）: ${eventTitle} - GoogleイベントID照合`);
      continue;
    }

    // Layer 2: タプル（イベント名 + 開始日付 + 誰の予定）で確認
    const existingByTuple = existingRecords.find(
      record =>
        record.title === eventTitle &&
        record.startDate === startDate &&
        record.owner === owner
    );

    if (existingByTuple) {
      console.log(`  ⊙ スキップ（既存）: ${eventTitle} - タプル照合`);
      continue;
    }

    // Layer 3: 新規イベント
    console.log(`  ✓ 新規: ${eventTitle} (${startDate}) - ${owner}`);
    newEvents.push({
      title: eventTitle,
      startDate: startDate,
      startDateTime: event.start,
      googleEventId: googleEventId,
      sourceCalendar: event.sourceCalendar,
      owner: owner,
      description: event.description || "",
      location: event.location || ""
    });
  }

  return newEvents;
}

/**
 * 新規イベントを Notion に追加
 */
async function createPagesInNotion(newEvents) {
  const pagesToCreate = newEvents.map(event => ({
    properties: {
      [NOTION_CONFIG.columns.title]: {
        title: [{ text: { content: event.title } }]
      },
      [NOTION_CONFIG.columns.startDate]: {
        date: {
          start: event.startDate,
          time: extractTimeString(event.startDateTime)
        }
      },
      [NOTION_CONFIG.columns.googleEventId]: {
        rich_text: [{ text: { content: event.googleEventId } }]
      },
      [NOTION_CONFIG.columns.syncSourceCalendar]: {
        rich_text: [{ text: { content: event.sourceCalendar } }]
      },
      [NOTION_CONFIG.columns.owner]: {
        select: { name: event.owner }
      }
    }
  }));

  try {
    for (const page of pagesToCreate) {
      await claude.mcp.notion.notion_create_pages({
        databaseId: NOTION_CONFIG.dataSourceId,
        properties: page.properties
      });
      console.log(`  ✓ 追加: ${page.properties[NOTION_CONFIG.columns.title].title[0].text.content}`);
    }
  } catch (error) {
    console.error("Notion ページ作成エラー:", error.message);
    throw error;
  }
}

/**
 * Google Calendar イベントから日付文字列を抽出
 */
function extractDateString(startObj) {
  if (startObj.date) {
    // 全日イベントの場合
    return startObj.date;
  } else if (startObj.dateTime) {
    // 時間付きイベントの場合
    return new Date(startObj.dateTime).toISOString().split('T')[0];
  }
  return "";
}

/**
 * Google Calendar イベントから時間文字列を抽出
 */
function extractTimeString(startObj) {
  if (startObj.dateTime) {
    const time = new Date(startObj.dateTime).toISOString().split('T')[1];
    return time.substring(0, 8);  // HH:MM:SS
  }
  return null;
}

// メイン処理の実行
if (require.main === module) {
  syncGoogleCalendarToNotion()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error("予期しないエラー:", error);
      process.exit(1);
    });
}

module.exports = { syncGoogleCalendarToNotion };
