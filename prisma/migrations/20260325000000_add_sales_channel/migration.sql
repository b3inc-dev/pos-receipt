-- AddSalesChannel: チャネル（仮想ロケーション）とその日次キャッシュを追加

-- ========== SalesChannel ==========
CREATE TABLE "SalesChannel" (
    "id"                     TEXT NOT NULL,
    "shopId"                 TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "displayName"            TEXT,
    "shortName"              TEXT,
    "sortOrder"              INTEGER NOT NULL DEFAULT 0,
    "salesSummaryEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "includeInOverallTotals" BOOLEAN NOT NULL DEFAULT true,
    "sourceNamesJson"        TEXT NOT NULL DEFAULT '[]',
    "sourceNamesSnapshot"    TEXT NOT NULL DEFAULT '[]',
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesChannel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesChannel_shopId_idx" ON "SalesChannel"("shopId");

ALTER TABLE "SalesChannel"
    ADD CONSTRAINT "SalesChannel_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ========== SalesChannelCacheDaily ==========
CREATE TABLE "SalesChannelCacheDaily" (
    "id"         TEXT NOT NULL,
    "shopId"     TEXT NOT NULL,
    "channelId"  TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "actual"     DECIMAL(18,2) NOT NULL,
    "orders"     INTEGER NOT NULL,
    "items"      INTEGER NOT NULL,
    "budget"     DECIMAL(18,2),
    "budgetRatio" DECIMAL(10,4),
    "atv"        DECIMAL(18,2),
    "setRate"    DECIMAL(10,4),
    "unit"       DECIMAL(18,2),
    "currency"   TEXT NOT NULL DEFAULT 'JPY',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesChannelCacheDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalesChannelCacheDaily_shopId_channelId_targetDate_key"
    ON "SalesChannelCacheDaily"("shopId", "channelId", "targetDate");

CREATE INDEX "SalesChannelCacheDaily_shopId_targetDate_idx"
    ON "SalesChannelCacheDaily"("shopId", "targetDate");

ALTER TABLE "SalesChannelCacheDaily"
    ADD CONSTRAINT "SalesChannelCacheDaily_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SalesChannelCacheDaily"
    ADD CONSTRAINT "SalesChannelCacheDaily_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "SalesChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
