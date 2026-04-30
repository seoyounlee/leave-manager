import { pool } from "./db";

// ─── 타입 정의 ─────────────────────────────────────────────────────────────────

export type LeaveType     = "full" | "half-am" | "half-pm";
export type RequestStatus = "pending" | "approved" | "rejected";

export const LEAVE_TYPE_KO: Record<LeaveType, string> = {
  full:      "종일",
  "half-am": "오전반차",
  "half-pm": "오후반차",
};

export const STATUS_KO: Record<RequestStatus, string> = {
  pending:  "대기중",
  approved: "승인",
  rejected: "반려",
};

export const DAYS_BY_TYPE: Record<LeaveType, number> = {
  full:      1,
  "half-am": 0.5,
  "half-pm": 0.5,
};

export interface Employee {
  id: string;
  name: string;
  totalDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  type: LeaveType;
  days: number;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

// ─── DB 행 → 타입 변환 ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEmployee(row: any): Employee {
  const total = parseFloat(row.total_days);
  const used  = parseFloat(row.used_days);
  return {
    id:            row.id,
    name:          row.name,
    totalDays:     total,
    usedDays:      round1(used),
    remainingDays: round1(Math.max(0, total - used)),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRequest(row: any): LeaveRequest {
  return {
    id:            row.id,
    employeeId:    row.employee_id,
    employeeName:  row.employee_name,
    date:          row.date,
    type:          row.type as LeaveType,
    days:          parseFloat(row.days),
    reason:        row.reason,
    status:        row.status as RequestStatus,
    createdAt:     row.created_at,
    reviewedAt:    row.reviewed_at  ?? null,
    reviewNote:    row.review_note  ?? null,
  };
}

// ─── 조회 ─────────────────────────────────────────────────────────────────────

export async function getEmployees(): Promise<Employee[]> {
  const { rows } = await pool.query("SELECT * FROM employees ORDER BY name");
  return rows.map(toEmployee);
}

export async function getRequests(
  filters: { employeeId?: string; status?: string } = {}
): Promise<LeaveRequest[]> {
  const params: string[] = [];
  const conds: string[]  = [];

  if (filters.employeeId) { params.push(filters.employeeId); conds.push(`employee_id = $${params.length}`); }
  if (filters.status)     { params.push(filters.status);     conds.push(`status = $${params.length}`); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT * FROM leave_requests ${where} ORDER BY created_at DESC`,
    params
  );
  return rows.map(toRequest);
}

// ─── 직원 관리 ─────────────────────────────────────────────────────────────────

export async function addEmployee(
  name: string,
  totalDays: number
): Promise<Employee[]> {
  if (!name.trim())  throw new Error("이름을 입력해주세요.");
  if (totalDays <= 0) throw new Error("총 연차는 0보다 커야 합니다.");

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await pool.query(
    "INSERT INTO employees (id, name, total_days, used_days) VALUES ($1, $2, $3, 0)",
    [id, name.trim(), totalDays]
  );
  return getEmployees();
}

export async function updateEmployeeTotal(
  employeeId: string,
  totalDays: number
): Promise<Employee[]> {
  // 이미 승인된 연차보다 작게 설정 방지
  const { rows } = await pool.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
  if (!rows.length) throw new Error("직원을 찾을 수 없습니다.");
  const emp = rows[0];

  if (totalDays < parseFloat(emp.used_days)) {
    throw new Error(`이미 승인된 연차(${emp.used_days}일)보다 작게 설정할 수 없습니다.`);
  }

  await pool.query("UPDATE employees SET total_days = $1 WHERE id = $2", [totalDays, employeeId]);
  return getEmployees();
}

// ─── 연차 신청 ─────────────────────────────────────────────────────────────────

export async function submitRequest(
  employeeId: string,
  fields: { date: string; type: LeaveType; reason: string }
): Promise<LeaveRequest[]> {
  // 직원 확인
  const empResult = await pool.query("SELECT * FROM employees WHERE id = $1", [employeeId]);
  if (!empResult.rows.length) throw new Error("직원을 찾을 수 없습니다.");
  const emp = empResult.rows[0];

  // 같은 날짜 중복 신청 방지 (pending | approved)
  const dup = await pool.query(
    "SELECT id, status FROM leave_requests WHERE employee_id = $1 AND date = $2 AND status IN ('pending','approved')",
    [employeeId, fields.date]
  );
  if (dup.rows.length) {
    throw new Error(
      `${fields.date}에 이미 ${STATUS_KO[dup.rows[0].status as RequestStatus]} 상태의 신청이 있습니다.`
    );
  }

  const id   = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const days = DAYS_BY_TYPE[fields.type];
  await pool.query(
    `INSERT INTO leave_requests
       (id, employee_id, employee_name, date, type, days, reason, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
    [id, employeeId, emp.name, fields.date, fields.type, days, fields.reason.trim(), new Date().toISOString()]
  );

  return getRequests({ employeeId });
}

// ─── 승인 ─────────────────────────────────────────────────────────────────────

export async function approveRequest(
  requestId: string,
  note?: string
): Promise<{ employees: Employee[]; requests: LeaveRequest[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 신청 확인 + 행 잠금 (동시 승인 방지)
    const reqRes = await client.query(
      "SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE",
      [requestId]
    );
    if (!reqRes.rows.length) throw new Error("신청 내역을 찾을 수 없습니다.");
    const req = reqRes.rows[0];

    if (req.status !== "pending") {
      throw new Error(`승인할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
    }

    // 직원 행 잠금 + 잔여 검사
    const empRes = await client.query(
      "SELECT * FROM employees WHERE id = $1 FOR UPDATE",
      [req.employee_id]
    );
    if (!empRes.rows.length) throw new Error("직원을 찾을 수 없습니다.");
    const emp = empRes.rows[0];

    const remaining = round1(parseFloat(emp.total_days) - parseFloat(emp.used_days));
    if (parseFloat(req.days) > remaining) {
      throw new Error(`잔여 연차(${remaining}일)가 부족합니다. (신청: ${req.days}일)`);
    }

    const now = new Date().toISOString();
    await client.query(
      "UPDATE leave_requests SET status='approved', reviewed_at=$1, review_note=$2 WHERE id=$3",
      [now, note ?? null, requestId]
    );
    await client.query(
      "UPDATE employees SET used_days = used_days + $1 WHERE id = $2",
      [req.days, req.employee_id]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { employees: await getEmployees(), requests: await getRequests() };
}

// ─── 반려 ─────────────────────────────────────────────────────────────────────

export async function rejectRequest(
  requestId: string,
  note?: string
): Promise<{ employees: Employee[]; requests: LeaveRequest[] }> {
  const reqRes = await pool.query("SELECT * FROM leave_requests WHERE id = $1", [requestId]);
  if (!reqRes.rows.length) throw new Error("신청 내역을 찾을 수 없습니다.");
  const req = reqRes.rows[0];

  if (req.status !== "pending") {
    throw new Error(`반려할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  await pool.query(
    "UPDATE leave_requests SET status='rejected', reviewed_at=$1, review_note=$2 WHERE id=$3",
    [new Date().toISOString(), note ?? null, requestId]
  );

  return { employees: await getEmployees(), requests: await getRequests() };
}

// ─── 승인 취소 ────────────────────────────────────────────────────────────────

export async function cancelApproved(
  requestId: string
): Promise<{ employees: Employee[]; requests: LeaveRequest[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reqRes = await client.query(
      "SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE",
      [requestId]
    );
    if (!reqRes.rows.length) throw new Error("신청 내역을 찾을 수 없습니다.");
    const req = reqRes.rows[0];

    if (req.status !== "approved") {
      throw new Error(`승인 취소할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
    }

    await client.query(
      "UPDATE leave_requests SET status='rejected', reviewed_at=$1, review_note='관리자 승인 취소' WHERE id=$2",
      [new Date().toISOString(), requestId]
    );
    await client.query(
      "UPDATE employees SET used_days = GREATEST(0, used_days - $1) WHERE id = $2",
      [req.days, req.employee_id]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { employees: await getEmployees(), requests: await getRequests() };
}

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return parseFloat(n.toFixed(1));
}
