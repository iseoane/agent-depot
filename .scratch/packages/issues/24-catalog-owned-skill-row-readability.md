# Catalog keeps active Package-owned Skill rows readable

Status: fixed and verified.

## Problem

Active Package-owned Skills appeared dim and their ownership explanation was
appended inline. Long Skill names, descriptions, or ownership text wrapped into
multiple physical terminal rows, making the Catalog difficult to scan and
increasing the height of each entry. A Package-owned Skill still needs a clear
owner explanation and must remain unavailable for loose installation.

## Fix

Keep each owned Skill row on one terminal line with end truncation, normal text
contrast, and a compact Package badge. Show the full ownership reason for the
highlighted Skill outside its row. Retain the existing refusal for marking or
installing an owned Skill as loose, and apply bulk marking or installation only
to loose Skills.

## Verification

- `tests/tui-catalog-view.test.tsx` checks one-line output at widths 40, 80, and
  120, after a narrow resize with Unicode and an unmanaged marker, readable
  contrast, and owned-Skill action refusals.
- `CatalogView` reserves the selected ownership notice's wrapped height using the current terminal width. It updates the list height when the selection or terminal width changes.
- `tests/tui-catalog-view.test.tsx` checks the complete Catalog call site at 40 columns and 16 rows, including the full notice and room for shell chrome.
- `tests/e2e/tui.e2e.test.ts` drives active Pi- and Claude-owned Skill rows with long Package names in a real PTY at 40 by 17 and 80 by 24. It checks the visible row window and Catalog key footer.
- The 40-by-17 PTY check failed with the previous seven-row reservation: `40-column PTY frame exceeded 17 rows`. It passes with the notice's wrapped line count reserved.
