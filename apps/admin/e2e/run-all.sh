#!/usr/bin/env bash
# Kör de självständiga browser-E2E-flödena mot en körande miljö (API :4000, admin :5173, kundapp :5174).
# Varje skript loggar in som samma administratörer, och en TOTP-kod får bara användas en gång per 30 s, så vi väntar mellan skripten.
set -u
cd "$(dirname "$0")"
rc=0
for f in grant.py assisted.py config.py roles2.py portal.py portal_import.py portal_news.py portal_events.py tournament.py tournament_ko.py tournament_groups.py billing.py portal_mailings.py portal_public.py pinball.py pinball_ko.py pinball_import.py; do
  echo "=== $f ==="
  python3 "$f" || { echo "MISSLYCKADES: $f"; rc=1; }
  sleep 31
done
exit $rc
