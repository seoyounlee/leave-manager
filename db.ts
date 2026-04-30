import { Pool } from "pg";

// DATABASE_URL 이 있으면 SSL 활성화 (Railway 환경)
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

/** 서버 최초 실행 시 테이블이 없으면 생성 */
export async function initDB(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id         TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      total_days NUMERIC NOT NULL,
      used_days  NUMERIC NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id            TEXT    PRIMARY KEY,
      employee_id   TEXT    NOT NULL,
      employee_name TEXT    NOT NULL,
      date          TEXT    NOT NULL,
      type          TEXT    NOT NULL,
      days          NUMERIC NOT NULL,
      reason        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    TEXT    NOT NULL,
      reviewed_at   TEXT,
      review_note   TEXT
    );
  `);
}
