import { prisma } from "./db";
import type { Employee, LeaveYear, LeaveRequest } from "@prisma/client";

// ─── 타입 ──────────────────────────────────────────────────────────────────

export type LeaveType = "FULL" | "HALF_AM" | "HALF_PM";
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export const LEAVE_TYPE_KO: Record<LeaveType, string> = {
  FULL: "종일",
  HALF_AM: "오전반차",
  HALF_PM: "오후반차",
};

export const STATUS_KO: Record<RequestStatus, string> = {
  PENDING: "대기중",
  APPROVED: "승인",
  REJECTED: "반려",
};

const DAYS_BY_TYPE: Record<LeaveType, number> = {
  FULL: 1,
  HALF_AM: 0.5,
  HALF_PM: 0.5,
};

export interface EmployeeWithYear {
  id: string;
  name: string;
  department: string;
  status: string;
  joinedAt: string;
  resignedAt: string | null;
  year: number;
  totalDays: number;
  usedDays: number;
  remainingDays: number;
  carryOver: number;
  hasPassword: boolean;
}

export interface RequestView {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  type: LeaveType;
  days: number;
  year: number;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return parseFloat(n.toFixed(1));
}

function currentYear(): number {
  return new Date().getFullYear();
}

function toEmployeeView(emp: Employee, ly: LeaveYear | null): EmployeeWithYear {
  const total = ly?.totalDays ?? 0;
  const used = ly?.usedDays ?? 0;
  return {
    id: emp.id,
    name: emp.name,
    department: emp.department,
    status: emp.status,
    joinedAt: emp.joinedAt.toISOString(),
    resignedAt: emp.resignedAt?.toISOString() ?? null,
    year: ly?.year ?? currentYear(),
    totalDays: total,
    usedDays: round1(used),
    remainingDays: round1(Math.max(0, total - used)),
    carryOver: ly?.carryOver ?? 0,
    hasPassword: !!emp.password,
  };
}

function toRequestView(req: LeaveRequest & { employee: { name: string } }): RequestView {
  return {
    id: req.id,
    employeeId: req.employeeId,
    employeeName: req.employee.name,
    date: req.date,
    type: req.type as LeaveType,
    days: req.days,
    year: req.year,
    reason: req.reason,
    status: req.status as RequestStatus,
    createdAt: req.createdAt.toISOString(),
    reviewedAt: req.reviewedAt?.toISOString() ?? null,
    reviewNote: req.reviewNote ?? null,
  };
}

// ─── 직원 조회 ──────────────────────────────────────────────────────────────

export async function getEmployees(
  year?: number,
  includeResigned = false,
): Promise<EmployeeWithYear[]> {
  const y = year ?? currentYear();
  const where = includeResigned ? {} : { status: "ACTIVE" as const };

  const emps = await prisma.employee.findMany({
    where,
    include: { leaveYears: { where: { year: y } } },
    orderBy: { name: "asc" },
  });

  return emps.map((e) => toEmployeeView(e, e.leaveYears[0] ?? null));
}

// ─── 직원 추가 ──────────────────────────────────────────────────────────────

export async function addEmployee(
  name: string,
  totalDays: number,
  department: string,
  joinedAt: string,
): Promise<EmployeeWithYear[]> {
  if (!name.trim()) throw new Error("이름을 입력해주세요.");
  if (totalDays <= 0) throw new Error("총 연차는 0보다 커야 합니다.");

  const y = currentYear();
  await prisma.employee.create({
    data: {
      name: name.trim(),
      department: department.trim(),
      joinedAt: new Date(joinedAt),
      totalDays,
      leaveYears: {
        create: { year: y, totalDays, usedDays: 0, carryOver: 0 },
      },
    },
  });

  return getEmployees(y);
}

// ─── 총 연차 수정 ──────────────────────────────────────────────────────────

export async function updateEmployeeTotal(
  employeeId: string,
  totalDays: number,
  year?: number,
): Promise<EmployeeWithYear[]> {
  const y = year ?? currentYear();

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId, year: y } },
  });
  if (!ly) throw new Error(`${y}년 연차 기간이 없습니다. 먼저 연차 기간을 시작해주세요.`);
  if (totalDays < ly.usedDays) {
    throw new Error(`이미 승인된 연차(${ly.usedDays}일)보다 작게 설정할 수 없습니다.`);
  }

  await prisma.leaveYear.update({
    where: { id: ly.id },
    data: { totalDays },
  });

  return getEmployees(y);
}

// ─── 퇴사 처리 ──────────────────────────────────────────────────────────────

export async function resignEmployee(
  employeeId: string,
): Promise<EmployeeWithYear[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  if (emp.status === "RESIGNED") throw new Error("이미 퇴사 처리된 직원입니다.");

  // 대기중 신청 자동 반려
  await prisma.leaveRequest.updateMany({
    where: { employeeId, status: "PENDING" },
    data: { status: "REJECTED", reviewNote: "퇴사 처리로 자동 반려", reviewedAt: new Date() },
  });

  await prisma.employee.update({
    where: { id: employeeId },
    data: { status: "RESIGNED", resignedAt: new Date() },
  });

  return getEmployees(currentYear(), true);
}

// ─── 퇴사 취소 (복직) ───────────────────────────────────────────────────────

export async function reinstateEmployee(
  employeeId: string,
): Promise<EmployeeWithYear[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  if (emp.status === "ACTIVE") throw new Error("재직 중인 직원입니다.");

  await prisma.employee.update({
    where: { id: employeeId },
    data: { status: "ACTIVE", resignedAt: null },
  });

  return getEmployees(currentYear(), true);
}

// ─── 직원 비밀번호 ──────────────────────────────────────────────────────────

export async function setEmployeePassword(
  employeeId: string,
  password: string,
): Promise<void> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  await prisma.employee.update({
    where: { id: employeeId },
    data: { password },
  });
}

export async function verifyEmployeePassword(
  employeeId: string,
  password: string,
): Promise<boolean> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return false;
  if (!emp.password) return false; // 비밀번호 미설정
  return emp.password === password;
}

// ─── 연차 기간 시작 ─────────────────────────────────────────────────────────

export async function startLeaveYear(
  year: number,
  carryOverOption: "none" | "all" | "partial" = "none",
  maxCarryOver = 0,
): Promise<{ created: number; skipped: number }> {
  const activeEmps = await prisma.employee.findMany({
    where: { status: "ACTIVE" },
    include: { leaveYears: { where: { year: year - 1 } } },
  });

  let created = 0;
  let skipped = 0;

  for (const emp of activeEmps) {
    const exists = await prisma.leaveYear.findUnique({
      where: { employeeId_year: { employeeId: emp.id, year } },
    });
    if (exists) {
      skipped++;
      continue;
    }

    const prevYear = emp.leaveYears[0];
    let carryOver = 0;
    if (prevYear && carryOverOption !== "none") {
      const remaining = Math.max(0, prevYear.totalDays - prevYear.usedDays);
      carryOver =
        carryOverOption === "all"
          ? remaining
          : Math.min(remaining, maxCarryOver);
    }

    await prisma.leaveYear.create({
      data: {
        employeeId: emp.id,
        year,
        totalDays: round1(emp.totalDays + carryOver),
        usedDays: 0,
        carryOver: round1(carryOver),
      },
    });
    created++;
  }

  return { created, skipped };
}

// ─── 연도 목록 ──────────────────────────────────────────────────────────────

export async function getAvailableYears(): Promise<number[]> {
  const rows = await prisma.leaveYear.groupBy({
    by: ["year"],
    orderBy: { year: "desc" },
  });
  const years = rows.map((r) => r.year);
  if (!years.length) years.push(currentYear());
  return years;
}

// ─── 연차 신청 ──────────────────────────────────────────────────────────────

export async function getRequests(
  filters: { employeeId?: string; status?: string; year?: number } = {},
): Promise<RequestView[]> {
  const where: Record<string, unknown> = {};
  if (filters.employeeId) where.employeeId = filters.employeeId;
  if (filters.status) where.status = filters.status;
  if (filters.year) where.year = filters.year;

  const reqs = await prisma.leaveRequest.findMany({
    where,
    include: { employee: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return reqs.map(toRequestView);
}

export async function submitRequest(
  employeeId: string,
  fields: { date: string; type: LeaveType; reason: string },
): Promise<RequestView[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  if (emp.status === "RESIGNED") throw new Error("퇴사한 직원은 연차를 신청할 수 없습니다.");

  // 같은 날짜 중복 체크
  const dup = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      date: fields.date,
      status: { in: ["PENDING", "APPROVED"] },
    },
  });
  if (dup) {
    throw new Error(
      `${fields.date}에 이미 ${STATUS_KO[dup.status as RequestStatus]} 상태의 신청이 있습니다.`,
    );
  }

  const y = currentYear();
  const days = DAYS_BY_TYPE[fields.type];

  await prisma.leaveRequest.create({
    data: {
      employeeId,
      date: fields.date,
      type: fields.type,
      days,
      year: y,
      reason: fields.reason.trim(),
    },
  });

  return getRequests({ employeeId });
}

// ─── 승인 ──────────────────────────────────────────────────────────────────

export async function approveRequest(
  requestId: string,
  note?: string,
): Promise<{ employees: EmployeeWithYear[]; requests: RequestView[] }> {
  const req = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error("신청 내역을 찾을 수 없습니다.");
  if (req.status !== "PENDING") {
    throw new Error(`승인할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId: req.employeeId, year: req.year } },
  });
  if (!ly) throw new Error("해당 연도의 연차 기간이 없습니다.");

  const remaining = round1(ly.totalDays - ly.usedDays);
  if (req.days > remaining) {
    throw new Error(`잔여 연차(${remaining}일)가 부족합니다. (신청: ${req.days}일)`);
  }

  await prisma.$transaction([
    prisma.leaveRequest.update({
      where: { id: requestId },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewNote: note ?? null },
    }),
    prisma.leaveYear.update({
      where: { id: ly.id },
      data: { usedDays: round1(ly.usedDays + req.days) },
    }),
  ]);

  return { employees: await getEmployees(), requests: await getRequests() };
}

// ─── 반려 ──────────────────────────────────────────────────────────────────

export async function rejectRequest(
  requestId: string,
  note?: string,
): Promise<{ employees: EmployeeWithYear[]; requests: RequestView[] }> {
  const req = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error("신청 내역을 찾을 수 없습니다.");
  if (req.status !== "PENDING") {
    throw new Error(`반려할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  await prisma.leaveRequest.update({
    where: { id: requestId },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: note ?? null },
  });

  return { employees: await getEmployees(), requests: await getRequests() };
}

// ─── 승인 취소 ──────────────────────────────────────────────────────────────

export async function cancelApproved(
  requestId: string,
): Promise<{ employees: EmployeeWithYear[]; requests: RequestView[] }> {
  const req = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error("신청 내역을 찾을 수 없습니다.");
  if (req.status !== "APPROVED") {
    throw new Error(`승인 취소할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId: req.employeeId, year: req.year } },
  });

  if (ly) {
    await prisma.$transaction([
      prisma.leaveRequest.update({
        where: { id: requestId },
        data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: "관리자 승인 취소" },
      }),
      prisma.leaveYear.update({
        where: { id: ly.id },
        data: { usedDays: round1(Math.max(0, ly.usedDays - req.days)) },
      }),
    ]);
  } else {
    await prisma.leaveRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: "관리자 승인 취소" },
    });
  }

  return { employees: await getEmployees(), requests: await getRequests() };
}
