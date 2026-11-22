-- 領収書の発行者: 領収書を発行した人（POS でピン留め中のスタッフ）の ID。名前は createdBy
ALTER TABLE "ReceiptIssue" ADD COLUMN "createdByStaffId" TEXT;
