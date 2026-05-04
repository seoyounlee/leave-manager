import { google } from "googleapis";

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID
  || "02a70f66a068257a01b1ba6d9aa8d7ab7425ec627037bb61fab0d822f39ee683@group.calendar.google.com";

let _calendar: ReturnType<typeof google.calendar> | null = null;

function getCalendar() {
  if (_calendar) return _calendar;

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    return null; // 설정 안 됨 → 캘린더 비활성
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  _calendar = google.calendar({ version: "v3", auth });
  return _calendar;
}

const LEAVE_TYPE_TITLE: Record<string, string> = {
  FULL: "연차",
  HALF_AM: "오전반차",
  HALF_PM: "오후반차",
  TIME_1H: "시간차(1h)",
  TIME_2H: "시간차(2h)",
  TIME_3H: "시간차(3h)",
  SUPPORT_2H: "지원대휴(2h)",
};

/**
 * 승인 시 구글 캘린더에 종일 이벤트 생성
 * 모든 유형을 종일(All-day)로 등록
 */
export async function createCalendarEvent(
  employeeName: string,
  date: string,
  type: string,
  reason: string,
): Promise<string | null> {
  const cal = getCalendar();
  if (!cal) return null;

  const title = `[${LEAVE_TYPE_TITLE[type] || type}] ${employeeName}`;
  // 종일 이벤트: end는 다음 날
  const endDate = new Date(date + "T00:00:00");
  endDate.setDate(endDate.getDate() + 1);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const res = await cal.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: title,
        description: `${LEAVE_TYPE_TITLE[type] || type} · ${reason}`,
        start: { date },
        end: { date: endStr },
        transparency: "opaque",
      },
    });
    return res.data.id ?? null;
  } catch (e) {
    console.error("[GCal] 이벤트 생성 실패:", (e as Error).message);
    return null;
  }
}

/**
 * 승인 취소 시 구글 캘린더에서 이벤트 삭제
 */
export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const cal = getCalendar();
  if (!cal || !eventId) return false;

  try {
    await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
    return true;
  } catch (e) {
    console.error("[GCal] 이벤트 삭제 실패:", (e as Error).message);
    return false;
  }
}

/**
 * Google Calendar 연동 가능 여부
 */
export function isCalendarEnabled(): boolean {
  return !!process.env.GOOGLE_CLIENT_EMAIL && !!process.env.GOOGLE_PRIVATE_KEY;
}
