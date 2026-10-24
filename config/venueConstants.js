// Values must match the venue_status_check constraint exactly.
const VENUE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  UNDER_MAINTENANCE: "UNDER_MAINTENANCE",
});

// Largest capacity a venue record accepts (SPM-73 boundary test). One place to
// change it; the database only requires a positive whole number.
const MAX_VENUE_CAPACITY = 100000;

module.exports = { VENUE_STATUS, MAX_VENUE_CAPACITY };
