// The values the public API accepts. The database stores source / lead_type as
// open text, so adding one here needs no migration.

// judith_ai: the visitor came through Judith (the homepage AI assistant); the
// form on /lead keeps that source even though it's the page that submits.
export const SOURCES = new Set(['website_form', 'lead_page', 'judith_ai']);

// Where a lead the team typed in by hand (LeadLive → ליד חדש) came from.
// Staff only: the public API never accepts these.
export const MANUAL_SOURCES = new Set(['phone', 'whatsapp', 'instagram', 'facebook', 'referral', 'walk_in', 'manual']);

export const LEAD_TYPES = new Set(['bridal', 'production', 'fashion', 'product', 'other']);

export const URGENCIES = new Set(['this_week', 'this_month', 'three_months', 'flexible']);

export const STATUSES = new Set(['new', 'in_progress', 'won', 'lost']);

// How a closed deal is paid (leads.deal.payment_method).
export const PAYMENT_METHODS = new Set(['transfer', 'credit', 'bit', 'cash', 'check', 'other']);

export const PAYMENT_LABELS = {
  transfer: 'העברה בנקאית',
  credit: 'אשראי',
  bit: 'ביט / פייבוקס',
  cash: 'מזומן',
  check: 'צ׳ק',
  other: 'אחר',
};

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
  phone: 'שיחת טלפון',
  whatsapp: 'וואטסאפ',
  instagram: 'אינסטגרם',
  facebook: 'פייסבוק',
  referral: 'המלצה',
  walk_in: 'הגיעו לסטודיו',
  manual: 'הוזן ידנית',
};
