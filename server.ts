import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { Parser as CsvParser } from "json2csv";
import { initDB } from "./db";
import {
  getEmployees,
  getRequests,
  addEmployee,
  updateEmployeeTotal,
  submitRequest,
  approveRequest,
  rejectRequest,
  cancelApproved,
  LEAVE_TYPE_KO,
  STATUS_KO,
  LeaveType,
} from "./data-handler";

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("❌  환경 변수 ADMIN_PASSWORD가 설정되지 않았습니다. .env 파일을 확인해주세요.");
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// /admin → 관리자 HTML
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── 공통 헬퍼 ─────────────────────────────────────────────────────────────────

const VALID_TYPES: LeaveType[] = ["full", "half-am", "half-pm"];

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// ─── 관리자 인증 미들웨어 ────────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const pw = req.headers["x-admin-password"] as string | undefined;
  if (!pw || pw !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "관리자 비밀번호가 올바르지 않습니다." });
    return;
  }
  next();
}

// ─── 인증 ─────────────────────────────────────────────────────────────────────

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
    return;
  }
  res.json({ ok: true });
});

// ─── 직원 ─────────────────────────────────────────────────────────────────────

app.get("/api/employees", async (_req, res) => {
  try {
    res.json(await getEmployees());
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/employees", requireAdmin, async (req, res) => {
  const { name, totalDays } = req.body as { name?: string; totalDays?: number };
  if (!name || typeof totalDays !== "number") {
    res.status(400).json({ error: "name(문자열)과 totalDays(숫자)는 필수입니다." });
    return;
  }
  try {
    res.json(await addEmployee(name, totalDays));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.patch("/api/employees/:id/total", requireAdmin, async (req, res) => {
  const { totalDays } = req.body as { totalDays?: number };
  if (typeof totalDays !== "number" || totalDays <= 0) {
    res.status(400).json({ error: "totalDays는 양수 숫자여야 합니다." });
    return;
  }
  try {
    res.json(await updateEmployeeTotal(req.params.id as string, totalDays));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ─── 연차 신청 (직원용) ────────────────────────────────────────────────────────

app.post("/api/requests", async (req, res) => {
  const { employeeId, date, type, reason } =
    req.body as { employeeId?: string; date?: string; type?: string; reason?: string };

  if (!employeeId) {
    res.status(400).json({ error: "employeeId는 필수입니다." }); return;
  }
  if (!date || !isValidDate(date)) {
    res.status(400).json({ error: "date는 YYYY-MM-DD 형식이어야 합니다." }); return;
  }
  if (!type || !VALID_TYPES.includes(type as LeaveType)) {
    res.status(400).json({ error: `type은 ${VALID_TYPES.join(" | ")} 중 하나여야 합니다.` }); return;
  }
  if (!reason?.trim()) {
    res.status(400).json({ error: "reason은 필수입니다." }); return;
  }

  try {
    const requests = await submitRequest(employeeId, { date, type: type as LeaveType, reason });
    res.json({ requests });
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/requests", async (req, res) => {
  const { employeeId, status } = req.query as { employeeId?: string; status?: string };
  try {
    res.json(await getRequests({ employeeId, status }));
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── 승인 / 반려 / 취소 (관리자 전용) ────────────────────────────────────────────

app.patch("/api/requests/:id/approve", requireAdmin, async (req, res) => {
  const { note } = req.body as { note?: string };
  try {
    res.json(await approveRequest(req.params.id as string, note));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.patch("/api/requests/:id/reject", requireAdmin, async (req, res) => {
  const { note } = req.body as { note?: string };
  try {
    res.json(await rejectRequest(req.params.id as string, note));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.patch("/api/requests/:id/cancel", requireAdmin, async (req, res) => {
  try {
    res.json(await cancelApproved(req.params.id as string));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ─── CSV 내보내기 (관리자 전용) ────────────────────────────────────────────────

app.get("/api/export/csv", requireAdmin, async (_req, res) => {
  try {
    const [employees, requests] = await Promise.all([getEmployees(), getRequests()]);
    if (!requests.length) {
      res.status(404).json({ error: "내보낼 연차 내역이 없습니다." }); return;
    }

    const empMap = new Map(employees.map((e) => [e.id, e]));
    const rows = [...requests]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => {
        const emp = empMap.get(r.employeeId);
        return {
          신청번호: r.id,
          직원이름: r.employeeName,
          연차날짜: r.date,
          종류:     LEAVE_TYPE_KO[r.type] ?? r.type,
          일수:     r.days,
          사유:     r.reason,
          상태:     STATUS_KO[r.status]   ?? r.status,
          신청일시: r.createdAt  ? new Date(r.createdAt).toLocaleString("ko-KR")  : "",
          처리일시: r.reviewedAt ? new Date(r.reviewedAt).toLocaleString("ko-KR") : "",
          메모:     r.reviewNote ?? "",
          총연차:   emp?.totalDays     ?? "",
          사용연차: emp?.usedDays      ?? "",
          잔여연차: emp?.remainingDays ?? "",
        };
      });

    const fields = [
      "신청번호","직원이름","연차날짜","종류","일수","사유",
      "상태","신청일시","처리일시","메모","총연차","사용연차","잔여연차",
    ];
    const csv   = new CsvParser({ fields }).parse(rows);
    const today = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`연차내역_${today}`)}.csv`
    );
    res.send("\uFEFF" + csv);
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── 서버 시작 ─────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`서버 실행 중 → http://localhost:${PORT}  (관리자: /admin)`)
    );
  })
  .catch((err) => {
    console.error("DB 초기화 실패:", err);
    process.exit(1);
  });
