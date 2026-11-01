// Values must match the venue_status_check constraint exactly.
const VENUE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  UNDER_MAINTENANCE: "UNDER_MAINTENANCE",
});

// Largest capacity a venue record accepts (SPM-73 boundary test). One place to
// change it; the database only requires a positive whole number.
const MAX_VENUE_CAPACITY = 100000;

// Venue data spells one layout both "Theater" and "THEATRE"; every list shows
// it once, as "Theatre" (developer request of 1 November 2026). Matching
// already treats the spellings as the same (venueModel normalise).
const canonicalLayout = (value) => (typeof value === "string" && /^theat(re|er)$/i.test(value.trim()) ? "Theatre" : value);

// The layouts offered in a list: canonical, each once whatever its case.
const layoutChoices = (values) => {
  const seen = new Map();
  for (const value of values) {
    const layout = canonicalLayout(value);
    if (typeof layout === "string" && layout.trim() && !seen.has(layout.trim().toLowerCase())) seen.set(layout.trim().toLowerCase(), layout.trim());
  }
  return [...seen.values()];
};

module.exports = { VENUE_STATUS, MAX_VENUE_CAPACITY, canonicalLayout, layoutChoices };
