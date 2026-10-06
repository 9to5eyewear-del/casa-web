// The values the public API accepts. The database stores source / lead_type as
// open text, so adding one here (e.g. 'judith_ai') needs no migration.

export const SOURCES = new Set(['website_form', 'lead_page']);

export const LEAD_TYPES = new Set(['bridal', 'production', 'fashion', 'product', 'other']);

export const URGENCIES = new Set(['this_week', 'this_month', 'three_months', 'flexible']);

export const STATUSES = new Set(['new', 'in_progress', 'won', 'lost']);

export const LEAD_TYPE_LABELS = {
  bridal: 'התארגנות כלה',
  production: 'הפקת צילום',
  fashion: 'צילום אופנה',
  product: 'צילום מוצר',
  other: 'אחר',
};
