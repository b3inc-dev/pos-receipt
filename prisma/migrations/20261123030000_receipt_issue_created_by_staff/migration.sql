-- 領収書の発行者: 注文の帰属スタッフの ID。複数は「,」区切り。名前は createdBy
ALTER TABLE "ReceiptIssue" ADD COLUMN "createdByStaffId" TEXT;
