-- 入店数を ciara-system と見せ合うための列（Ciara のカスタムアプリだけで使う）。今の行は POS で入れた数として、入れた時刻 = 最後に変わった時刻にする
ALTER TABLE "FootfallReport" ADD COLUMN "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "FootfallReport" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'pos';
UPDATE "FootfallReport" SET "enteredAt" = "updatedAt";
