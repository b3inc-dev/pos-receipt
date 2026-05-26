-- 失敗・チェックサム不一致で止まった SettlementOperationLock マイグレーション記録を削除
-- （テーブル本体は ensure-settlement-operation-lock.sql で別途作成済み想定）
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260526120000_settlement_operation_lock';
