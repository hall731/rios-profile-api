#!/usr/bin/env bash
# verify-sync.sh — are these copies still the same as the dashboard's originals?
#
# These four functions and the migration are COPIES of files that live in
# hall731/remote-insight-os. Copies drift. This codebase has been bitten by
# exactly that before (matchVA duplicated across the gate and chat), so the
# drift is checked by a script rather than by eye.
#
# Usage, with both repos cloned side by side:
#   SRC=../remote-insight-os bash scripts/verify-sync.sh
#
# Exits non-zero and prints a diff if anything has drifted.

set -uo pipefail
SRC="${SRC:-../remote-insight-os}"

if [ ! -d "$SRC" ]; then
  echo "verify-sync: can't find the dashboard repo at '$SRC'."
  echo "  Clone hall731/remote-insight-os beside this one, or set SRC=/path/to/it."
  exit 2
fi

STATUS=0
check() {  # check <path relative to both repos>
  if [ ! -f "$SRC/$1" ]; then
    echo "DRIFT  $1 — missing in the dashboard repo (was it renamed there?)"
    STATUS=1
  elif ! diff -q "$SRC/$1" "$1" >/dev/null; then
    echo "DRIFT  $1"
    diff -u "$SRC/$1" "$1" | sed 's/^/       /'
    STATUS=1
  else
    echo "ok     $1"
  fi
}

check netlify/functions/va-profile-read.js
check netlify/functions/_profile-sso-verify.js
check netlify/functions/_profile-api-common.js
check netlify/functions/_client-sso-verify.js
check netlify/functions/_clients-db.js
check netlify/functions/client-login.js
check netlify/functions/_calendar-db.js
check netlify/functions/va-calendar-read.js
check netlify/functions/_documents-db.js
check netlify/functions/documents-portal.js
check netlify/functions/document-view-close.js
check netlify/functions/_profiles-db.js
check netlify/functions/_jwt.js
check netlify/functions/_ack-db.js
check netlify/functions/_ack-docs.js
check netlify/functions/_events-db.js
check netlify/functions/ack-status.js
check netlify/functions/ack-accept.js
check netlify/functions/events-ingest.js
check netlify/functions/_scrypt.js
check netlify/functions/_credentials-db.js
check netlify/functions/va-credential-check.js
check tests/va-profile-read.test.js
check tests/profile-api-endpoints.test.js
check tests/client-login.test.js
check tests/va-calendar-read.test.js
check tests/documents-portal.test.js
check tests/va-credential-check.test.js
check supabase/migrations/20260824170000_va_profiles.sql
check supabase/migrations/20260924090000_events.sql
check supabase/migrations/20260924100000_acknowledgments.sql
check supabase/migrations/20260924110000_clients.sql
check supabase/migrations/20260924120000_calendar.sql
check supabase/migrations/20260924130000_documents.sql
check supabase/migrations/20261007150000_va_credentials.sql

if [ "$STATUS" -ne 0 ]; then
  echo
  echo "The dashboard is the source of truth. Copy its version over, re-run the"
  echo "tests, and redeploy this site."
fi
exit "$STATUS"
