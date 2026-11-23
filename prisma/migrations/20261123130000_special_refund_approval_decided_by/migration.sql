-- 特殊返金の承認・却下をした人（見直し P2-1・T の決定 2026-11-23 16:20）
-- 20261123120000 を当てたあとに足した列なので、別の migration に分けた（当て済みの DB でも入るように）。
-- 先の版の 20261123120000（この列入り）を当てた DB・手で足した DB でも落ちないよう IF NOT EXISTS
-- AlterTable
ALTER TABLE "SpecialRefundEvent" ADD COLUMN IF NOT EXISTS "approvalDecidedBy" TEXT;
