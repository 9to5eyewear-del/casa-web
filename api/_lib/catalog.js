// The values the public API accepts. The database stores source / lead_type as
// open text, so adding one here needs no migration.

// judith_ai: the visitor came through Judith (the homepage AI assistant); the
// form on /lead keeps that source even though it's the page that submits.
export const SOURCES = new Set(['website_form', 'lead_page', 'judith_ai']);

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

// Display names; an unknown source still shows up everywhere under its raw key.
export const SOURCE_LABELS = {
  website_form: 'טופס באתר',
  lead_page: 'דף ליד',
  judith_ai: 'יהודית AI',
};
