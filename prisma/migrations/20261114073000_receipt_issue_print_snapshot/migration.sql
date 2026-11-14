-- Preserve the exact receipt template values and issued location name used for reprints.
-- Existing rows remain readable through the legacy fallback path.
ALTER TABLE "ReceiptIssue"
ADD COLUMN "printSnapshotJson" TEXT;
