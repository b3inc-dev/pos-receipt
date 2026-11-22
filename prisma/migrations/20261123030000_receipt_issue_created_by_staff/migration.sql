-- 領収書の発行者: POS でピン留め中（ログイン中）のスタッフ ID。表示名は createdBy（取れたときだけ）
ALTER TABLE "ReceiptIssue" ADD COLUMN "createdByStaffId" TEXT;
