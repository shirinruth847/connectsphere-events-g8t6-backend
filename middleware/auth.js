// Verifies the Supabase Auth access token and attaches the ConnectSphere user profile.
// Frontend must send:  Authorization: Bearer <access_token>
const supabase = require('../config/supabase');
const { findUserByEmail } = require('../model/userModel');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    // TC-004: no session -> 401. The frontend redirects to the Login page on 401.
    if (!token) {
      return res.status(401).json({ message: 'Please log in to continue.' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
    }

    // Links the Supabase Auth login to public.user through the (unique) email column.
    const profile = await findUserByEmail(data.user.email);
    if (!profile) {
      return res.status(403).json({ message: 'No ConnectSphere account is linked to this login.' });
    }

    req.user = profile; // { user_id, email, name, role }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Usage: requireRole('ORGANISER') or requireRole('COORDINATOR', 'ORGANISER')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Please log in to continue.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };