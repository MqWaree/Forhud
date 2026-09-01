-- Preserve existing listing records while removing obsolete scraped account
-- attributes. The mapped title/priceMinor/listingUrl columns remain in place
-- to make this migration safe for existing SQLite installations.
UPDATE "RustAccountListing"
SET "accountType" = '',
    "seller" = '',
    "availability" = '',
    "sourcePage" = '';
