-- AlterTable: POSロケーション以外の返金の計上先フラグ
ALTER TABLE "Location" ADD COLUMN "nonPosRefundAttributionEnabled" BOOLEAN NOT NULL DEFAULT false;
